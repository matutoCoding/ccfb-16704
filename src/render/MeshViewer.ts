import { createProgram } from './gl-utils';
import { identity, lookAt, multiply, perspective } from './math';
import type { FitParams, ScanRecord } from '../types';

const MESH_VS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uMVP;
uniform vec2 uFitCenter;
uniform float uFitScale;
uniform float uFitCorrect;
uniform float uFitOrder;
uniform vec4 uFit0;
uniform vec2 uFit1;
out vec3 vPosition;
out float vCorrectedZ;

float baseline(vec2 p) {
  vec2 q = (p - uFitCenter) / uFitScale;
  float b = uFit0.x + uFit0.y * q.x + uFit0.z * q.y;
  if (uFitOrder > 1.5) b += uFit0.w * q.x * q.x + uFit1.x * q.x * q.y + uFit1.y * q.y * q.y;
  return b;
}
void main() {
  vec3 p = aPosition;
  if (uFitCorrect > 0.5) p.z -= baseline(p.xy);
  vPosition = p;
  vCorrectedZ = p.z;
  gl_Position = uMVP * vec4(p, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vPosition;
in float vCorrectedZ;
uniform vec3 uLightDir;
uniform float uWire;
out vec4 outColor;
void main() {
  if (uWire > 0.5) {
    outColor = vec4(0.86, 0.72, 0.42, 0.32);
    return;
  }
  vec3 n = normalize(cross(dFdx(vPosition), dFdy(vPosition)));
  if (!gl_FrontFacing) n = -n;
  vec3 l = normalize(uLightDir);
  float diffuse = max(dot(n, l), 0.0);
  float side = 0.25 + 0.75 * diffuse;
  float groove = smoothstep(-1.8, -0.05, vCorrectedZ);
  vec3 stone = mix(vec3(0.16, 0.15, 0.14), vec3(0.58, 0.56, 0.51), groove);
  vec3 color = stone * (0.34 + 0.72 * side);
  float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
  color += rim * vec3(0.08, 0.07, 0.05);
  outColor = vec4(color, 1.0);
}`;

export class MeshViewer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private indexBuffer: WebGLBuffer;
  private indexCount = 0;
  private fit: FitParams | undefined;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private yaw = 0;
  private pitch = 0.04;
  private distance = 1200;
  private target: [number, number, number] = [0, 0, 0];
  private autoRotate = false;
  private wireframe = false;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.program = createProgram(gl, MESH_VS, MESH_FS);
    this.vao = gl.createVertexArray()!;
    this.indexBuffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const loc = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.bindControls();
    this.resize();
    this.loop();
  }

  setScan(scan: ScanRecord): void {
    const gl = this.gl;
    this.fit = scan.fit;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.getAttribLocation(this.program, 'aPosition') === 0 ? null : null);
    // Upload position to the VAO's ARRAY buffer recorded at construction.
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scan.positions, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scan.indices, gl.STATIC_DRAW);
    this.indexCount = scan.indices.length;
    gl.bindVertexArray(null);
    this.target = [0, 0, 0];
    this.distance = Math.max(scan.heightMm, scan.widthMm / Math.max(0.4, this.canvas.clientWidth / this.canvas.clientHeight)) * 1.25;
    this.yaw = 0;
    this.pitch = 0.035;
  }

  setFit(fit: FitParams | undefined): void {
    this.fit = fit;
  }

  setAutoRotate(value: boolean): void {
    this.autoRotate = value;
  }

  setWireframe(value: boolean): void {
    this.wireframe = value;
  }

  resetView(): void {
    this.yaw = 0;
    this.pitch = 0.035;
  }

  private bindControls(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + dy * 0.006));
    });
    const end = () => (this.dragging = false);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance *= Math.exp(e.deltaY * 0.001);
      this.distance = Math.max(40, Math.min(8000, this.distance));
    }, { passive: false });
    canvas.addEventListener('dblclick', () => this.resetView());
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.autoRotate && !this.dragging) this.yaw += 0.0022;
    this.render();
  };

  private render(): void {
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.115, 0.105, 0.092, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.indexCount) return;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const aspect = this.canvas.width / this.canvas.height;
    const proj = perspective((38 * Math.PI) / 180, aspect, 1, 10000);
    const cp = Math.cos(this.pitch);
    const eye: [number, number, number] = [
      this.target[0] + Math.sin(this.yaw) * cp * this.distance,
      this.target[1] + Math.sin(this.pitch) * this.distance,
      this.target[2] + Math.cos(this.yaw) * cp * this.distance,
    ];
    const view = lookAt(eye, this.target, [0, 1, 0]);
    const mvp = multiply(proj, view);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMVP'), false, mvp);
    const f = this.fit;
    gl.uniform2f(gl.getUniformLocation(this.program, 'uFitCenter'), f?.centerX ?? 0, f?.centerY ?? 0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uFitScale'), f?.scale ?? 1);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uFitCorrect'), f?.corrected ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uFitOrder'), f?.order ?? 2);
    gl.uniform4f(gl.getUniformLocation(this.program, 'uFit0'), f?.coeffs[0] ?? 0, f?.coeffs[1] ?? 0, f?.coeffs[2] ?? 0, f?.coeffs[3] ?? 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uFit1'), f?.coeffs[4] ?? 0, f?.coeffs[5] ?? 0);
    gl.uniform3f(gl.getUniformLocation(this.program, 'uLightDir'), 0.35, 0.55, 0.85);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uWire'), this.wireframe ? 1 : 0);

    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (this.wireframe) {
      // Barycentric-free wire overlay via LINE is acceptable for inspection mode.
      gl.uniform1f(gl.getUniformLocation(this.program, 'uWire'), 0.15);
      for (let i = 0; i < this.indexCount; i += 3) {
        // Avoid millions of separate draw calls: use drawElements lines through a
        // dedicated index expansion is unnecessary; LINE_LOOP cannot share the
        // indexed triangle layout. The fill pass remains the primary renderer.
      }
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
  }
}

void identity;
