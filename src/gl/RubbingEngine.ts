import type { HeightField, RetouchStroke, RubbingParams } from '../types';
import { DIFF_FS, FULLSCREEN_VS, RUBBING_FS_ES1, RUBBING_FS_ES3, STROKE_FS, STROKE_VS } from './shaders';

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface RenderOptions {
  params: RubbingParams;
  strokes: RetouchStroke[];
  inkColor?: string;
  paperColor?: string;
  tileSize?: number;
  onProgress?: (pct: number) => void;
}

/**
 * 数字拓片 WebGL2 引擎
 * - 高度场以 R32F 纹理存储，NEAREST 采样保证刻口不被双线性插值糊掉
 * - 分块渲染支持任意 DPI 的全分辨率离屏输出
 * - 补墨场为独立 R16F 纹理，可整层清空实现撤销
 */
export class RubbingEngine {
  readonly gl: WebGL2RenderingContext;
  private prog3!: WebGLProgram;
  private prog1: WebGLProgram | null = null;
  private strokeProg: WebGLProgram;
  private diffProg: WebGLProgram;
  private heightTex: WebGLTexture | null = null;
  private retouchTex: WebGLTexture | null = null;
  private vao: WebGLVertexArrayObject;
  private hf: HeightField | null = null;
  private es3 = true;
  private retouchDirty = true;
  private cachedStrokes: RetouchStroke[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    try {
      this.prog3 = program(gl, FULLSCREEN_VS, RUBBING_FS_ES3);
    } catch {
      this.es3 = false;
      this.prog1 = program(gl, FULLSCREEN_VS.replace('#version 300 es', '#version 100'), RUBBING_FS_ES1);
    }
    this.strokeProg = program(gl, STROKE_VS, STROKE_FS);
    this.diffProg = program(gl, FULLSCREEN_VS, DIFF_FS);
  }

  get isEs3(): boolean {
    return this.es3;
  }

  /** 上传/替换高度场 */
  setHeightField(hf: HeightField): void {
    const gl = this.gl;
    if (!this.heightTex) this.heightTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, hf.widthPx, hf.heightPx, 0, gl.RED, gl.FLOAT, hf.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hf = hf;
    this.retouchDirty = true;
  }

  private ensureRetouchTexture(): void {
    const gl = this.gl;
    if (!this.hf) throw new Error('尚未加载高度场');
    if (!this.retouchTex) {
      this.retouchTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.retouchTex);
      const internal = this.es3 ? gl.R16F : gl.R32F;
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, this.hf.widthPx, this.hf.heightPx, 0, gl.RED, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.retouchTex, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** 重建补墨纹理（撤销后以完整笔触列表重绘） */
  rebuildRetouch(strokes: RetouchStroke[]): void {
    if (!this.hf) return;
    const gl = this.gl;
    this.ensureRetouchTexture();
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.retouchTex, 0);
    gl.viewport(0, 0, this.hf.widthPx, this.hf.heightPx);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // 叠加
    gl.useProgram(this.strokeProg);
    gl.activeTexture(gl.TEXTURE0);
    for (const s of strokes) {
      const cx = (s.cxMm / this.hf.widthMm) * 2 - 1;
      const cy = 1 - (s.cyMm / this.hf.heightMm) * 2;
      const rPx = s.radiusMm * this.hf.pxPerMm;
      gl.uniform2f(gl.getUniformLocation(this.strokeProg, 'uCenter'), cx, cy);
      gl.uniform1f(gl.getUniformLocation(this.strokeProg, 'uRadiusPx'), rPx);
      gl.uniform1f(gl.getUniformLocation(this.strokeProg, 'uStrength'), s.strength);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.deleteFramebuffer(fbo);
    this.cachedStrokes = strokes.slice();
    this.retouchDirty = false;
  }

  clearRetouch(): void {
    if (!this.retouchTex || !this.hf) return;
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.retouchTex, 0);
    gl.viewport(0, 0, this.hf.widthPx, this.hf.heightPx);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.deleteFramebuffer(fbo);
    this.cachedStrokes = [];
  }

  private bindCommon(prog: WebGLProgram, opts: RenderOptions, tile: { ox: number; oy: number; sx: number; sy: number }): void {
    const gl = this.gl;
    const hf = this.hf!;
    gl.uniform1i(gl.getUniformLocation(prog, 'uHeight'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uRetouch'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.retouchTex);
    const p = opts.params;
    gl.uniform2f(gl.getUniformLocation(prog, 'uTexel'), 1 / hf.widthPx, 1 / hf.heightPx);
    gl.uniform1f(gl.getUniformLocation(prog, 'uPxPerMm'), hf.pxPerMm);
    gl.uniform1f(gl.getUniformLocation(prog, 'uInkPouchMm'), p.inkPouchMm);
    gl.uniform1f(gl.getUniformLocation(prog, 'uContrast'), p.contrast);
    gl.uniform1f(gl.getUniformLocation(prog, 'uGamma'), p.gamma);
    gl.uniform1f(gl.getUniformLocation(prog, 'uRoughness'), p.roughness);
    gl.uniform1f(gl.getUniformLocation(prog, 'uPaperGrain'), p.paperGrain);
    gl.uniform1f(gl.getUniformLocation(prog, 'uEdgeEnhance'), p.edgeEnhance);
    gl.uniform1f(gl.getUniformLocation(prog, 'uTime'), 0.37);
    const [ir, ig, ib] = hexToRgb(opts.inkColor ?? '#141210');
    const [pr, pg, pb] = hexToRgb(opts.paperColor ?? '#f2ede1');
    gl.uniform3f(gl.getUniformLocation(prog, 'uInkColor'), ir, ig, ib);
    gl.uniform3f(gl.getUniformLocation(prog, 'uPaperColor'), pr, pg, pb);
    gl.uniform2f(gl.getUniformLocation(prog, 'uTileOffset'), tile.ox, tile.oy);
    gl.uniform2f(gl.getUniformLocation(prog, 'uTileScale'), tile.sx, tile.sy);
  }

  /** 屏幕预览（渲染到当前 canvas） */
  renderPreview(canvas: HTMLCanvasElement, opts: RenderOptions): void {
    if (!this.hf) return;
    if (this.retouchDirty) this.rebuildRetouch(opts.strokes);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const prog = this.es3 ? this.prog3 : this.prog1!;
    gl.useProgram(prog);
    this.bindCommon(prog, opts, { ox: 0, oy: 0, sx: 1, sy: 1 });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 全分辨率离屏渲染：按 tileSize 分块读回，避免一次性巨大绘制缓冲。
   * 返回拼接好的 ImageData（宽高与高度场像素一致，或按 outputScale 放大）。
   */
  async renderFull(
    outW: number,
    outH: number,
    opts: RenderOptions,
  ): Promise<ImageData> {
    if (!this.hf) throw new Error('尚未加载高度场');
    if (this.retouchDirty) this.rebuildRetouch(opts.strokes);
    const gl = this.gl;
    const tile = opts.tileSize ?? 1024;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tile, tile, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const result = new ImageData(outW, outH);
    const prog = this.es3 ? this.prog3 : this.prog1!;
    gl.useProgram(prog);
    const tilesX = Math.ceil(outW / tile);
    const tilesY = Math.ceil(outH / tile);
    const total = tilesX * tilesY;
    let done = 0;

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tile;
        const y0 = ty * tile;
        const w = Math.min(tile, outW - x0);
        const h = Math.min(tile, outH - y0);
        gl.viewport(0, 0, w, h);
        // 分块 UV：输出像素 (x0..x0+w) 映射到全图 UV
        this.bindCommon(prog, opts, {
          ox: x0 / outW,
          oy: y0 / outH,
          sx: w / outW,
          sy: h / outH,
        });
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // WebGL 原点在左下，翻转行后写入
        for (let row = 0; row < h; row++) {
          const srcStart = (h - 1 - row) * w * 4;
          const dstStart = ((y0 + row) * outW + x0) * 4;
          result.data.set(px.subarray(srcStart, srcStart + w * 4), dstStart);
        }
        done++;
        opts.onProgress?.(done / total);
        if ((done & 3) === 0) await new Promise((r) => setTimeout(r, 0));
      }
    }
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return result;
  }

  /** 只读访问高度场（供 CPU 侧算法使用） */
  get heightField(): HeightField | null {
    return this.hf;
  }

  dispose(): void {
    const gl = this.gl;
    [this.heightTex, this.retouchTex].forEach((t) => t && gl.deleteTexture(t));
    [this.prog3, this.prog1, this.strokeProg, this.diffProg].forEach((p) => p && gl.deleteProgram(p));
    gl.deleteVertexArray(this.vao);
  }
}
