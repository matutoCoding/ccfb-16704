export function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`GLSL 编译失败: ${log}\n${source}`);
  }
  return shader;
}

export function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WebGL program 链接失败: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function createBuffer(gl: WebGL2RenderingContext, target: number, data: BufferSource, usage = gl.STATIC_DRAW): WebGLBuffer {
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('无法创建 GPU buffer');
  gl.bindBuffer(target, buffer);
  gl.bufferData(target, data, usage);
  return buffer;
}

export function getUniforms<T extends string>(gl: WebGL2RenderingContext, program: WebGLProgram, names: readonly T[]): Record<T, WebGLUniformLocation | null> {
  const result = {} as Record<T, WebGLUniformLocation | null>;
  for (const name of names) result[name] = gl.getUniformLocation(program, name);
  return result;
}

export function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}
