import { createProgram } from './gl-utils';
import { baselineAt } from '../geometry/mesh';
import type { FitParams, RubbingParams, ScanRecord } from '../types';

const QUAD_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2(
    float((gl_VertexID << 1) & 2),
    float(gl_VertexID & 2)
  );
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEIGHT_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform vec4 uView;
uniform vec2 uFitCenter;
uniform float uFitScale;
uniform float uFitCorrect;
uniform float uFitOrder;
uniform vec4 uFit0;
uniform vec2 uFit1;
out float vHeight;
out vec2 vMm;

float baseline(vec2 p) {
  vec2 q = (p - uFitCenter) / uFitScale;
  float b = uFit0.x + uFit0.y * q.x + uFit0.z * q.y;
  if (uFitOrder > 1.5) {
    b += uFit0.w * q.x * q.x + uFit1.x * q.x * q.y + uFit1.y * q.y * q.y;
  }
  return b;
}

void main() {
  float h = aPosition.z;
  if (uFitCorrect > 0.5) h -= baseline(aPosition.xy);
  vHeight = h;
  vMm = aPosition.xy;
  vec2 center = (uView.xy + uView.zw) * 0.5;
  vec2 halfSize = (uView.zw - uView.xy) * 0.5;
  vec2 clip = (aPosition.xy - center) / halfSize;
  float z = clamp(-h * 0.055, -0.92, 0.92);
  gl_Position = vec4(clip, z, 1.0);
}`;

const ENCODE_GLSL = `
uniform float uHeightMin;
uniform float uHeightMax;
vec4 encodeHeight(float h) {
  float v = clamp((h - uHeightMin) / (uHeightMax - uHeightMin), 0.0, 1.0);
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
  enc = fract(enc);
  enc.xyz -= enc.yzw / 255.0;
  return vec4(enc.rgb, 1.0);
}
float decodeHeight(vec4 rgba) {
  float v = dot(rgba, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
  return uHeightMin + clamp(v, 0.0, 1.0) * (uHeightMax - uHeightMin);
}
`;

const HEIGHT_FS = `#version 300 es
precision highp float;
${ENCODE_GLSL}
in float vHeight;
out vec4 outColor;
void main() {
  outColor = encodeHeight(vHeight);
}`;

const INK_FS = `#version 300 es
precision highp float;
${ENCODE_GLSL}
uniform sampler2D uHeight;
uniform sampler2D uEdit;
uniform float uHasEdit;
uniform vec2 uTexel;
uniform vec2 uRectMin;
uniform vec2 uRectMax;
uniform float uMmPerPixel;
uniform float uInkDensity;
uniform float uContrast;
uniform float uCutThreshold;
uniform float uEdgeWidthMm;
uniform float uWeathering;
uniform float uPaperStrength;
uniform float uPaperScale;
uniform float uPadTexture;
uniform float uPadScaleMm;
uniform float uInkWarmth;
uniform float uPreset;

in vec2 vUv;
out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec4 raw = texture(uHeight, vUv);
  if (raw.a < 0.5) {
    outColor = vec4(0.93, 0.91, 0.86, 1.0);
    return;
  }
  float h = decodeHeight(raw);
  float hL = decodeHeight(texture(uHeight, vUv - vec2(uTexel.x, 0.0)));
  float hR = decodeHeight(texture(uHeight, vUv + vec2(uTexel.x, 0.0)));
  float hD = decodeHeight(texture(uHeight, vUv - vec2(0.0, uTexel.y)));
  float hU = decodeHeight(texture(uHeight, vUv + vec2(0.0, uTexel.y)));

  vec2 mm = mix(uRectMin, uRectMax, vUv);
  float cut = max(0.0, -h);
  float slope = (abs(hR - hL) + abs(hU - hD)) / max(0.05, 2.0 * uMmPerPixel);
  float curvature = abs(hL + hR + hU + hD - 4.0 * h) / max(0.0025, uMmPerPixel * uMmPerPixel);
  float rough = clamp(slope * 0.10 + curvature * 0.055, 0.0, 1.0);

  // Anchor the transition at the depth threshold. A symmetric interval whose
  // lower end goes negative would turn tiny fit/quantization noise into a
  // global grey veil. The upper interval is about one output pixel.
  float edgeAa = max(uEdgeWidthMm, uMmPerPixel * 0.75);
  float edge = smoothstep(uCutThreshold, uCutThreshold + edgeAa, cut);

  // Share octave noise between weathering, ink pad and paper to keep 600 DPI
  // tile export fill-rate within the 10 second target.
  float macro = fbm(mm / max(8.0, uPadScaleMm) * 1.8 + vec2(4.0, 12.0));
  float meso = fbm(mm * 0.18 * uPaperScale + vec2(7.0, 2.0));
  float micro = fbm(mm * 0.52 * uPaperScale + vec2(2.0, 19.0));
  float broadPits = smoothstep(0.58, 0.92, macro);
  float microFlower = smoothstep(0.68, 0.96, micro);
  float weatherMask = clamp(
    edge + uWeathering * (rough * 0.72 + broadPits * rough * 0.32 + microFlower * 0.10 * (0.25 + rough)),
    0.0, 1.0
  );

  float pad = macro;
  float fineInk = micro;
  float ink = (1.0 - weatherMask * (0.88 + 0.12 * uWeathering));
  ink *= 1.0 - uPadTexture * (0.10 + 0.22 * pad);
  ink *= 0.965 + 0.055 * fineInk;
  ink *= uInkDensity;

  // Local restoration /补墨 mask.
  if (uHasEdit > 0.5) {
    vec4 editSample = texture(uEdit, vUv);
    float editAlpha = editSample.a;
    float burn = editSample.r * editAlpha;
    float dodge = editSample.g * editAlpha;
    ink += burn * 0.72;
    ink *= 1.0 - dodge * 0.88;
  }

  ink = clamp(ink, 0.0, 1.0);
  float mid = 0.42;
  ink = clamp((ink - 0.5) * uContrast + 0.5 + (1.0 - uContrast) * mid, 0.0, 1.0);

  float fiberA = noise(vec2(mm.x * 0.10 * uPaperScale, mm.y * 1.8 * uPaperScale));
  float fiberB = noise(vec2(mm.x * 1.7 * uPaperScale, mm.y * 0.16 * uPaperScale));
  float fiber = mix(fiberA, fiberB, 0.35);
  float paperShade = 0.86 + 0.12 * fiber - uPaperStrength * 0.10 * meso;
  vec3 paper = vec3(paperShade, paperShade * (0.965 + uInkWarmth * 0.05), paperShade * (0.90 + uInkWarmth * 0.10));
  float inkGray = uPreset > 1.5 ? 0.10 : 0.035 + uInkWarmth * 0.055;
  vec3 inkColor = vec3(inkGray, inkGray * (0.96 - uInkWarmth * 0.08), inkGray * (0.90 - uInkWarmth * 0.16));
  vec3 color = mix(paper, inkColor, pow(ink, 0.82));
  outColor = vec4(color, 1.0);
}`;

export interface RenderRect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export class RubbingEngine {
  readonly canvas: HTMLCanvasElement;
  readonly maxTextureSize: number;
  private gl: WebGL2RenderingContext;
  private heightProgram: WebGLProgram;
  private inkProgram: WebGLProgram;
  private meshBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexCount = 0;
  private fit: FitParams | undefined;
  private heightTexture: WebGLTexture;
  private heightFbo: WebGLFramebuffer;
  private depthBuffer: WebGLRenderbuffer;
  private inkTexture: WebGLTexture;
  private inkFbo: WebGLFramebuffer;
  private editTexture: WebGLTexture;
  private hasEdit = false;
  private targetW = 1;
  private targetH = 1;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('当前浏览器或设备未启用 WebGL2');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    this.heightProgram = createProgram(gl, HEIGHT_VS, HEIGHT_FS);
    this.inkProgram = createProgram(gl, QUAD_VS, INK_FS);
    this.heightTexture = gl.createTexture()!;
    this.heightFbo = gl.createFramebuffer()!;
    this.depthBuffer = gl.createRenderbuffer()!;
    this.inkTexture = gl.createTexture()!;
    this.inkFbo = gl.createFramebuffer()!;
    this.editTexture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.editTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  setScan(scan: ScanRecord): void {
    const gl = this.gl;
    this.fit = scan.fit;
    if (this.meshBuffer) gl.deleteBuffer(this.meshBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    this.meshBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scan.positions, gl.STATIC_DRAW);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scan.indices, gl.STATIC_DRAW);
    this.indexCount = scan.indices.length;
  }

  setEditSource(source: CanvasImageSource | TexImageSource | null): void {
    const gl = this.gl;
    const texSource = source as TexImageSource | null;
    gl.bindTexture(gl.TEXTURE_2D, this.editTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (texSource) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texSource);
      this.hasEdit = true;
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      this.hasEdit = false;
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private ensureTargets(width: number, height: number): void {
    if (width === this.targetW && height === this.targetH) return;
    const gl = this.gl;
    this.targetW = width;
    this.targetH = height;

    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.heightTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);

    gl.bindTexture(gl.TEXTURE_2D, this.inkTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.inkFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.inkTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  renderTile(rect: RenderRect, width: number, height: number, params: RubbingParams): Uint8Array {
    if (!this.meshBuffer || !this.indexBuffer) throw new Error('尚未载入扫描网格');
    const gl = this.gl;
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    this.ensureTargets(width, height);
    const mmPerPixelX = (rect.xMax - rect.xMin) / width;
    const mmPerPixelY = (rect.yMax - rect.yMin) / height;
    const mmPerPixel = (mmPerPixelX + mmPerPixelY) / 2;

    // Height pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFbo);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.heightProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer);
    const posLoc = gl.getAttribLocation(this.heightProgram, 'aPosition');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    setUniform(gl, this.heightProgram, 'uView', '4f', rect.xMin, rect.yMin, rect.xMax, rect.yMax);
    const f = this.fit;
    setUniform(gl, this.heightProgram, 'uFitCenter', '2f', f?.centerX ?? 0, f?.centerY ?? 0);
    setUniform(gl, this.heightProgram, 'uFitScale', '1f', f?.scale ?? 1);
    setUniform(gl, this.heightProgram, 'uFitCorrect', '1f', f?.corrected ? 1 : 0);
    setUniform(gl, this.heightProgram, 'uFitOrder', '1f', f?.order ?? 2);
    setUniform(gl, this.heightProgram, 'uFit0', '4f', f?.coeffs[0] ?? 0, f?.coeffs[1] ?? 0, f?.coeffs[2] ?? 0, f?.coeffs[3] ?? 0);
    setUniform(gl, this.heightProgram, 'uFit1', '2f', f?.coeffs[4] ?? 0, f?.coeffs[5] ?? 0);
    setUniform(gl, this.heightProgram, 'uHeightMin', '1f', -5);
    setUniform(gl, this.heightProgram, 'uHeightMax', '1f', 2.5);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // Ink pass.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.inkFbo);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.inkProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTexture);
    gl.uniform1i(gl.getUniformLocation(this.inkProgram, 'uHeight'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.editTexture);
    gl.uniform1i(gl.getUniformLocation(this.inkProgram, 'uEdit'), 1);
    setUniform(gl, this.inkProgram, 'uHasEdit', '1f', this.hasEdit ? 1 : 0);
    setUniform(gl, this.inkProgram, 'uHeightMin', '1f', -5);
    setUniform(gl, this.inkProgram, 'uHeightMax', '1f', 2.5);
    setUniform(gl, this.inkProgram, 'uTexel', '2f', 1 / width, 1 / height);
    setUniform(gl, this.inkProgram, 'uRectMin', '2f', rect.xMin, rect.yMin);
    setUniform(gl, this.inkProgram, 'uRectMax', '2f', rect.xMax, rect.yMax);
    setUniform(gl, this.inkProgram, 'uMmPerPixel', '1f', mmPerPixel);
    setUniform(gl, this.inkProgram, 'uInkDensity', '1f', params.inkDensity);
    setUniform(gl, this.inkProgram, 'uContrast', '1f', params.contrast);
    setUniform(gl, this.inkProgram, 'uCutThreshold', '1f', params.cutThresholdMm);
    const edgeWidth = Math.max(mmPerPixel * 0.55, mmPerPixel * (1.35 - params.edgeSharpness));
    setUniform(gl, this.inkProgram, 'uEdgeWidthMm', '1f', edgeWidth);
    setUniform(gl, this.inkProgram, 'uWeathering', '1f', params.weathering);
    setUniform(gl, this.inkProgram, 'uPaperStrength', '1f', params.paperStrength);
    setUniform(gl, this.inkProgram, 'uPaperScale', '1f', params.paperScale);
    setUniform(gl, this.inkProgram, 'uPadTexture', '1f', params.padTexture);
    setUniform(gl, this.inkProgram, 'uPadScaleMm', '1f', params.padScaleMm);
    setUniform(gl, this.inkProgram, 'uInkWarmth', '1f', params.inkWarmth);
    setUniform(gl, this.inkProgram, 'uPreset', '1f', params.preset === 'chanyi' ? 2 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  renderImageData(rect: RenderRect, width: number, height: number, params: RubbingParams): ImageData {
    const raw = this.renderTile(rect, width, height, params);
    const image = new ImageData(width, height);
    // gl.readPixels is bottom-up; ImageData is top-down.
    for (let y = 0; y < height; y++) {
      const srcStart = (height - 1 - y) * width * 4;
      const dstStart = y * width * 4;
      image.data.set(raw.subarray(srcStart, srcStart + width * 4), dstStart);
    }
    return image;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.meshBuffer) gl.deleteBuffer(this.meshBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    gl.deleteTexture(this.heightTexture);
    gl.deleteTexture(this.inkTexture);
    gl.deleteTexture(this.editTexture);
    gl.deleteFramebuffer(this.heightFbo);
    gl.deleteFramebuffer(this.inkFbo);
    gl.deleteRenderbuffer(this.depthBuffer);
    gl.deleteProgram(this.heightProgram);
    gl.deleteProgram(this.inkProgram);
  }
}

function setUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string, type: string, ...values: number[]): void {
  const location = gl.getUniformLocation(program, name);
  if (!location) return;
  if (type === '1f') gl.uniform1f(location, values[0]);
  if (type === '2f') gl.uniform2f(location, values[0], values[1]);
  if (type === '4f') gl.uniform4f(location, values[0], values[1], values[2], values[3]);
}

export function fullRect(scan: ScanRecord): RenderRect {
  return {
    xMin: -scan.widthMm / 2,
    xMax: scan.widthMm / 2,
    yMin: -scan.heightMm / 2,
    yMax: scan.heightMm / 2,
  };
}

export { baselineAt };
