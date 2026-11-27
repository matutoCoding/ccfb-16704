// WebGL2 GLSL 着色器：数字拓片墨包模型
// 物理模型：墨包轻拍时纸面被压向石面，高度场局部上包络 g = max(z)（高斯加权），
// 凹陷处纸面悬空吃不到墨 -> 留白；凸起/平面处吃墨 -> 黑。

export const FULLSCREEN_VS = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------- ES 3.00 版（R32F 高度场纹理，显式 LOD 采样） ----------
export const RUBBING_FS_ES3 = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uHeight;
uniform sampler2D uRetouch;   // R16F 或 R32F，补墨场，0 表示无修改
uniform vec2 uTexel;          // 1/纹理尺寸
uniform float uPxPerMm;
uniform float uInkPouchMm;
uniform float uContrast;
uniform float uGamma;
uniform float uRoughness;
uniform float uPaperGrain;
uniform float uEdgeEnhance;
uniform float uTime;
uniform vec3 uInkColor;
uniform vec3 uPaperColor;
uniform vec2 uTileOffset;    // 当前分块在全图中的 UV 偏移
uniform vec2 uTileScale;     // 当前分块 UV 缩放

// 确定性值噪声
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p *= 2.03; a *= 0.5; }
  return v;
}

float sampleH(vec2 uv) {
  return textureLod(uHeight, clamp(uv, vec2(0.0), vec2(1.0)), 0.0).r;
}

void main() {
  vec2 uv = uTileOffset + vUv * uTileScale;
  float sigmaPx = max(uInkPouchMm * uPxPerMm, 0.6);
  int R = int(ceil(sigmaPx * 2.2)) + 1;

  // 1. 高斯加权局部最大高度（墨包上包络），sigma 内解析近似
  float gMax = -1e9;
  float wSum = 0.0;
  for (int dy = -24; dy <= 24; dy++) {
    for (int dx = -24; dx <= 24; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      vec2 d = vec2(float(dx), float(dy));
      float w = exp(-dot(d, d) / (2.0 * sigmaPx * sigmaPx));
      float h = sampleH(uv + d * uTexel);
      gMax = max(gMax, h + log(max(w, 1e-4)) * (sigmaPx * sigmaPx) * 0.0);
      wSum += w;
    }
  }
  // 软 max：log-sum-exp 近似，物理上对应墨包柔性接触
  float lse = -1e9;
  for (int dy = -24; dy <= 24; dy++) {
    for (int dx = -24; dx <= 24; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      vec2 d = vec2(float(dx), float(dy));
      float w = exp(-dot(d, d) / (2.0 * sigmaPx * sigmaPx));
      float h = sampleH(uv + d * uTexel);
      lse = max(lse, h + log(max(w, 1e-4)));
    }
  }
  float envelope = lse;

  // 2. 高度差：纸面（上包络）与实际石面之差，>0 即悬空留白
  float z = sampleH(uv);
  float gap = envelope - z;

  // 3. 石花/泐痕：微尺度粗糙度，保留细小凹点
  float rough = 0.0;
  float rSigma = max(sigmaPx * 0.35, 0.7);
  int rR = int(ceil(rSigma * 1.6)) + 1;
  for (int dy = -8; dy <= 8; dy++) {
    for (int dx = -8; dx <= 8; dx++) {
      if (dx * dx + dy * dy > rR * rR) continue;
      vec2 d = vec2(float(dx), float(dy));
      float w = exp(-dot(d, d) / (2.0 * rSigma * rSigma));
      rough += abs(sampleH(uv + d * uTexel) - z) * w;
    }
  }

  // 4. 刻口边缘梯度（中心差分，抗锯齿）
  float hL = sampleH(uv - vec2(uTexel.x, 0.0));
  float hR = sampleH(uv + vec2(uTexel.x, 0.0));
  float hU = sampleH(uv - vec2(0.0, uTexel.y));
  float hD = sampleH(uv + vec2(0.0, uTexel.y));
  float grad = length(vec2(hR - hL, hD - hU)) * 0.5 * uPxPerMm;

  // 5. 墨量：凹陷 gap 越大墨越少；粗糙度制造石花；高梯度边缘锐化
  float ink = 1.0 - smoothstep(0.02, max(0.25, uInkPouchMm * 0.9), gap);
  float stoneFlower = clamp(rough * 3.2, 0.0, 1.0) * uRoughness;
  ink *= 1.0 - stoneFlower * 0.85;
  // 边缘增强：刻口内侧梯度高的位置压暗，保持笔画边界锐利
  float edge = smoothstep(0.15, 1.2, grad) * uEdgeEnhance;
  ink = clamp(ink + edge * 0.28 * (1.0 - ink), 0.0, 1.0);
  ink = clamp(ink * uContrast + (1.0 - uContrast) * 0.55, 0.0, 1.0);
  ink = pow(ink, uGamma);

  // 6. 补墨场（拓工补墨：正加深负减淡）
  float retouch = textureLod(uRetouch, uv, 0.0).r;
  ink = clamp(ink + retouch, 0.0, 1.0);

  // 7. 纸张纹理（纤维 + 颗粒，仅调制墨色，不制造几何信息）
  vec2 mm = uv * vec2(textureSize(uHeight, 0)) / uPxPerMm;
  float grain = fbm(mm * 0.9 + uTime * 0.0);
  float fiber = vnoise(mm * vec2(6.0, 0.8) + 13.7) - 0.5;
  float paperMod = 1.0 - uPaperGrain * (0.5 * (grain - 0.5) + 0.6 * fiber);
  ink = clamp(ink * paperMod, 0.0, 1.0);

  vec3 col = mix(uPaperColor, uInkColor, ink);
  outColor = vec4(col, 1.0);
}`;

// ---------- ES 1.00 兼容回退（纹理用 NEAREST，无 textureLod） ----------
export const RUBBING_FS_ES1 = `#version 100
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight;
uniform sampler2D uRetouch;
uniform vec2 uTexel;
uniform float uPxPerMm;
uniform float uInkPouchMm;
uniform float uContrast;
uniform float uGamma;
uniform float uRoughness;
uniform float uPaperGrain;
uniform float uEdgeEnhance;
uniform float uTime;
uniform vec3 uInkColor;
uniform vec3 uPaperColor;
uniform vec2 uTileOffset;
uniform vec2 uTileScale;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 s = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p *= 2.03; a *= 0.5; }
  return v;
}
float sampleH(vec2 uv) { return texture2D(uHeight, clamp(uv, vec2(0.0), vec2(1.0))).r; }

void main() {
  vec2 uv = uTileOffset + vUv * uTileScale;
  float sigmaPx = max(uInkPouchMm * uPxPerMm, 0.6);
  int R = int(ceil(sigmaPx * 2.2)) + 1;
  float lse = -1e9;
  for (int dy = -24; dy <= 24; dy++) {
    for (int dx = -24; dx <= 24; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      vec2 d = vec2(float(dx), float(dy));
      float w = exp(-dot(d, d) / (2.0 * sigmaPx * sigmaPx));
      float h = sampleH(uv + d * uTexel);
      lse = max(lse, h + log(max(w, 1e-4)));
    }
  }
  float envelope = lse;
  float z = sampleH(uv);
  float gap = envelope - z;

  float rough = 0.0;
  float rSigma = max(sigmaPx * 0.35, 0.7);
  int rR = int(ceil(rSigma * 1.6)) + 1;
  for (int dy = -8; dy <= 8; dy++) {
    for (int dx = -8; dx <= 8; dx++) {
      if (dx * dx + dy * dy > rR * rR) continue;
      vec2 d = vec2(float(dx), float(dy));
      float w = exp(-dot(d, d) / (2.0 * rSigma * rSigma));
      rough += abs(sampleH(uv + d * uTexel) - z) * w;
    }
  }
  float hL = sampleH(uv - vec2(uTexel.x, 0.0));
  float hR = sampleH(uv + vec2(uTexel.x, 0.0));
  float hU = sampleH(uv - vec2(0.0, uTexel.y));
  float hD = sampleH(uv + vec2(0.0, uTexel.y));
  float grad = length(vec2(hR - hL, hD - hU)) * 0.5 * uPxPerMm;

  float ink = 1.0 - smoothstep(0.02, max(0.25, uInkPouchMm * 0.9), gap);
  float stoneFlower = clamp(rough * 3.2, 0.0, 1.0) * uRoughness;
  ink *= 1.0 - stoneFlower * 0.85;
  float edge = smoothstep(0.15, 1.2, grad) * uEdgeEnhance;
  ink = clamp(ink + edge * 0.28 * (1.0 - ink), 0.0, 1.0);
  ink = clamp(ink * uContrast + (1.0 - uContrast) * 0.55, 0.0, 1.0);
  ink = pow(ink, uGamma);
  float retouch = texture2D(uRetouch, uv).r;
  ink = clamp(ink + retouch, 0.0, 1.0);

  vec2 mm = uv / uTexel / uPxPerMm;
  float grain = fbm(mm * 0.9 + uTime * 0.0);
  float fiber = vnoise(mm * vec2(6.0, 0.8) + 13.7) - 0.5;
  float paperMod = 1.0 - uPaperGrain * (0.5 * (grain - 0.5) + 0.6 * fiber);
  ink = clamp(ink * paperMod, 0.0, 1.0);

  vec3 col = mix(uPaperColor, uInkColor, ink);
  gl_FragColor = vec4(col, 1.0);
}`;

// 补墨场绘制（径向高斯笔触）
export const STROKE_VS = `#version 300 es
precision highp float;
uniform vec2 uCenter;
uniform float uRadiusPx;
out vec2 vRel;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vRel = p;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const STROKE_FS = `#version 300 es
precision highp float;
in vec2 vRel;
out float outValue;
uniform float uStrength;
void main() {
  float d = length(vRel);
  if (d > 1.0) discard;
  outValue = uStrength * exp(-d * d * 3.0);
}`;

// 配准差异高亮
export const DIFF_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uRubbing;
uniform sampler2D uOldPhoto;
uniform sampler2D uDiffMask;
uniform float uBlend;
uniform float uShowDiff;
void main() {
  vec3 rub = texture(uRubbing, vUv).rgb;
  vec3 old = texture(uOldPhoto, vUv).rgb;
  vec3 base = mix(old, rub, uBlend);
  float d = texture(uDiffMask, vUv).r;
  vec3 hl = vec3(0.95, 0.25, 0.15);
  base = mix(base, hl, d * uShowDiff * 0.75);
  outColor = vec4(base, 1.0);
}`;
