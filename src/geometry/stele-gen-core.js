// 程序化碑面生成核心（纯 ESM，Node 与浏览器共用）
// 生成带阴刻楷书笔画、风化坑、整体倾斜与弯曲的规则网格碑面
// 坐标单位 mm；输出 z 为包含弯曲的原始高度

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
function hash2(ix, iy, seed = 0) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
function fbm(x, y, oct = 4, seed = 0) {
  let sum = 0, amp = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { sum += valueNoise(x * f, y * f, seed + o * 17) * amp; n += amp; amp *= 0.5; f *= 2.03; }
  return sum / n;
}

// ---------- 楷书笔画：线段/曲线段，带宽度与深度 ----------
// seg: {type:'line', x1,y1,x2,y2,w} 或 {type:'quad', x1,y1,cx,cy,x2,y2,w}
// 坐标在 1000x1000 em 方框内

const GLYPHS = {
  永: {
    segs: [
      { type: 'quad', x1: 180, y1: 150, cx: 500, cy: 90, x2: 820, y2: 160, w: 58 },   // 点(侧)
      { type: 'line', x1: 500, y1: 170, x2: 495, y2: 860, w: 64 },                    // 努(竖)
      { type: 'quad', x1: 200, y1: 330, cx: 430, cy: 430, x2: 480, y2: 470, w: 52 },  // 勒(横)
      { type: 'quad', x1: 800, y1: 300, cx: 620, cy: 460, x2: 520, y2: 500, w: 48 },  // 掠
      { type: 'quad', x1: 510, y1: 470, cx: 700, cy: 600, x2: 830, y2: 760, w: 50 },  // 趯
      { type: 'quad', x1: 470, y1: 560, cx: 300, cy: 680, x2: 170, y2: 820, w: 44 },  // 啄
      { type: 'quad', x1: 520, y1: 560, cx: 660, cy: 720, x2: 800, y2: 860, w: 46 },  // 磔
    ],
  },
  和: {
    segs: [
      { type: 'line', x1: 330, y1: 120, x2: 325, y2: 880, w: 56 },
      { type: 'line', x1: 150, y1: 300, x2: 500, y2: 290, w: 44 },
      { type: 'line', x1: 170, y1: 560, x2: 480, y2: 555, w: 44 },
      { type: 'quad', x1: 300, y1: 320, cx: 220, cy: 450, x2: 215, y2: 540, w: 36 },
      { type: 'quad', x1: 360, y1: 320, cx: 440, cy: 450, x2: 445, y2: 540, w: 36 },
      { type: 'line', x1: 560, y1: 380, x2: 880, y2: 375, w: 52 },
      { type: 'line', x1: 580, y1: 200, x2: 575, y2: 860, w: 50 },
      { type: 'line', x1: 570, y1: 600, x2: 870, y2: 595, w: 46 },
      { type: 'line', x1: 730, y1: 200, x2: 725, y2: 860, w: 42 },
    ],
  },
  四: {
    segs: [
      { type: 'line', x1: 160, y1: 220, x2: 860, y2: 215, w: 52 },
      { type: 'line', x1: 170, y1: 230, x2: 165, y2: 820, w: 52 },
      { type: 'line', x1: 850, y1: 225, x2: 845, y2: 815, w: 52 },
      { type: 'line', x1: 150, y1: 830, x2: 860, y2: 825, w: 54 },
      { type: 'quad', x1: 330, y1: 320, cx: 360, cy: 520, x2: 340, y2: 700, w: 38 },
      { type: 'quad', x1: 520, y1: 310, cx: 550, cy: 520, x2: 530, y2: 710, w: 38 },
      { type: 'quad', x1: 700, y1: 320, cx: 670, cy: 520, x2: 690, y2: 700, w: 38 },
    ],
  },
  海: {
    segs: [
      { type: 'line', x1: 150, y1: 200, x2: 145, y2: 860, w: 44 },
      { type: 'line', x1: 170, y1: 330, x2: 330, y2: 280, w: 36 },
      { type: 'line', x1: 175, y1: 520, x2: 335, y2: 480, w: 36 },
      { type: 'quad', x1: 180, y1: 720, cx: 260, cy: 680, x2: 340, y2: 660, w: 36 },
      { type: 'line', x1: 400, y1: 160, x2: 880, y2: 155, w: 48 },
      { type: 'line', x1: 430, y1: 340, x2: 850, y2: 335, w: 42 },
      { type: 'line', x1: 640, y1: 170, x2: 635, y2: 880, w: 46 },
      { type: 'quad', x1: 450, y1: 560, cx: 540, cy: 700, x2: 600, y2: 860, w: 40 },
      { type: 'quad', x1: 820, y1: 540, cx: 720, cy: 700, x2: 660, y2: 870, w: 40 },
    ],
  },
  内: {
    segs: [
      { type: 'line', x1: 230, y1: 180, x2: 820, y2: 175, w: 52 },
      { type: 'line', x1: 250, y1: 190, x2: 245, y2: 850, w: 50 },
      { type: 'line', x1: 800, y1: 190, x2: 795, y2: 830, w: 50 },
      { type: 'quad', x1: 795, y1: 830, cx: 700, cy: 900, x2: 560, y2: 880, w: 40 },
      { type: 'line', x1: 520, y1: 300, x2: 515, y2: 760, w: 48 },
      { type: 'quad', x1: 515, y1: 760, cx: 600, cy: 830, x2: 700, y2: 790, w: 38 },
      { type: 'quad', x1: 350, y1: 330, cx: 460, cy: 460, x2: 500, y2: 520, w: 40 },
    ],
  },
  平: {
    segs: [
      { type: 'line', x1: 180, y1: 240, x2: 840, y2: 235, w: 54 },
      { type: 'line', x1: 260, y1: 430, x2: 760, y2: 425, w: 46 },
      { type: 'line', x1: 500, y1: 250, x2: 495, y2: 880, w: 56 },
      { type: 'line', x1: 160, y1: 880, x2: 850, y2: 875, w: 52 },
    ],
  },
  安: {
    segs: [
      { type: 'line', x1: 240, y1: 170, x2: 780, y2: 165, w: 56 },
      { type: 'line', x1: 500, y1: 110, x2: 495, y2: 330, w: 44 },
      { type: 'quad', x1: 330, y1: 300, cx: 500, cy: 420, x2: 680, y2: 310, w: 40 },
      { type: 'line', x1: 200, y1: 470, x2: 800, y2: 465, w: 50 },
      { type: 'line', x1: 330, y1: 480, x2: 325, y2: 700, w: 42 },
      { type: 'line', x1: 680, y1: 480, x2: 675, y2: 700, w: 42 },
      { type: 'line', x1: 170, y1: 720, x2: 840, y2: 715, w: 50 },
      { type: 'line', x1: 500, y1: 720, x2: 495, y2: 900, w: 46 },
    ],
  },
  乐: {
    segs: [
      { type: 'line', x1: 500, y1: 110, x2: 495, y2: 880, w: 52 },
      { type: 'line', x1: 180, y1: 240, x2: 840, y2: 235, w: 48 },
      { type: 'line', x1: 260, y1: 380, x2: 460, y2: 375, w: 40 },
      { type: 'line', x1: 550, y1: 375, x2: 760, y2: 370, w: 40 },
      { type: 'line', x1: 270, y1: 520, x2: 455, y2: 515, w: 40 },
      { type: 'line', x1: 555, y1: 515, x2: 750, y2: 510, w: 40 },
      { type: 'line', x1: 170, y1: 680, x2: 850, y2: 675, w: 50 },
      { type: 'quad', x1: 350, y1: 690, cx: 280, cy: 800, x2: 200, y2: 890, w: 42 },
      { type: 'quad', x1: 660, y1: 690, cx: 740, cy: 800, x2: 810, y2: 890, w: 42 },
    ],
  },
};

const GLYPH_ORDER = ['永', '和', '四', '海', '内', '平', '安', '乐'];

function quadPoint(seg, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * seg.x1 + 2 * mt * t * seg.cx + t * t * seg.x2,
    y: mt * mt * seg.y1 + 2 * mt * t * seg.cy + t * t * seg.y2,
  };
}

function distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy || 1e-9;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / l2, 0, 1);
  const qx = x1 + t * dx, qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** 点到笔画中心线的最小距离（em 坐标） */
function distToGlyph(glyph, ex, ey) {
  let best = Infinity;
  for (const seg of glyph.segs) {
    if (seg.type === 'line') {
      best = Math.min(best, distPointSeg(ex, ey, seg.x1, seg.y1, seg.x2, seg.y2) - seg.w / 2);
    } else {
      const STEPS = 16;
      for (let k = 0; k < STEPS; k++) {
        const p0 = quadPoint(seg, k / STEPS);
        const p1 = quadPoint(seg, (k + 1) / STEPS);
        best = Math.min(best, distPointSeg(ex, ey, p0.x, p0.y, p1.x, p1.y) - seg.w / 2);
      }
    }
  }
  return best; // <0 表示在笔画内部
}

/**
 * 生成碑面参数
 * @typedef {Object} SteleGenOptions
 * @property {number} widthMm
 * @property {number} heightMm
 * @property {number} nx 网格列数
 * @property {number} ny 网格行数
 * @property {number} grooveDepthMm 刻槽深度
 * @property {number} seed
 */
export function defaultSteleOptions() {
  return { widthMm: 800, heightMm: 1000, nx: 900, ny: 1280, grooveDepthMm: 1.6, grooveWallMm: 0.45, seed: 20261128 };
}

/** 24 字布局：4 列 x 6 行（传统从右往左读：永和四海內平安樂…） */
export function layoutCharacters(widthMm, heightMm) {
  const cols = 4, rows = 6;
  const marginX = widthMm * 0.11;
  const marginTop = heightMm * 0.08;
  const marginBottom = heightMm * 0.07;
  const cellW = (widthMm - marginX * 2) / cols;
  const cellH = (heightMm - marginTop - marginBottom) / rows;
  const chars = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const charText = GLYPH_ORDER[n % GLYPH_ORDER.length];
      const readCol = cols - 1 - c; // 从右至左
      const x = marginX + readCol * cellW;
      const y = marginTop + r * cellH;
      chars.push({ text: charText, x, y, w: cellW * 0.82, h: cellH * 0.82, index: n });
      n++;
    }
  }
  return chars;
}

/** 确定性生成风化坑（圆形坑，参数化以便与真值区分） */
export function makePits(opts) {
  const pits = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    const r1 = hash2(i, 7, opts.seed);
    const r2 = hash2(i, 13, opts.seed);
    const r3 = hash2(i, 23, opts.seed);
    const r4 = hash2(i, 31, opts.seed);
    pits.push({
      cx: r1 * opts.widthMm,
      cy: r2 * opts.heightMm,
      radius: 2.5 + r3 * 9,
      depth: 0.25 + r4 * 0.9,
    });
  }
  return pits;
}

/** 查询某物理坐标处刻槽深度（不含坑），同时返回最近字符序号（-1 表示不在字上） */
export function grooveDepthAt(xMm, yMm, opts, chars) {
  let depth = 0;
  let charIndex = -1;
  for (const ch of chars) {
    if (xMm < ch.x - 2 || xMm > ch.x + ch.w + 2 || yMm < ch.y - 2 || yMm > ch.y + ch.h + 2) continue;
    const ex = ((xMm - ch.x) / ch.w) * 1000;
    const ey = ((yMm - ch.y) / ch.h) * 1000;
    if (ex < -30 || ex > 1030 || ey < -30 || ey > 1030) continue;
    const d = distToGlyph(GLYPHS[ch.text], ex, ey);
    if (d < 0) {
      // 槽壁为物理宽度（em->mm 换算），默认约 0.45mm 的窄壁，保证刻口锐利
      const wallEm = (opts.grooveWallMm ?? 0.45) / (ch.w / 1000);
      const edge = smooth(-d / wallEm);
      depth = Math.max(depth, opts.grooveDepthMm * edge);
      charIndex = ch.index;
    }
  }
  return { depth, charIndex };
}

function pitDepthAt(x, y, pits) {
  let d = 0;
  for (const p of pits) {
    const r = Math.hypot(x - p.cx, y - p.cy);
    if (r < p.radius) d = Math.max(d, p.depth * smooth(1 - r / p.radius));
  }
  return d;
}

/**
 * 生成碑面网格（含整体倾斜 + 二次弯曲 + 石面微起伏 + 阴刻 + 风化坑）
 * @returns {{positions: Float32Array, indices: Uint32Array, chars: any[], pits: any[], opts: object}}
 */
export function generateSteleMesh(genOpts) {
  const opts = { ...defaultSteleOptions(), ...genOpts };
  const { widthMm: W, heightMm: H, nx, ny } = opts;
  const chars = layoutCharacters(W, H);
  const pits = makePits(opts);

  const count = nx * ny;
  const positions = new Float32Array(count * 3);
  // 整体形变：倾斜 0.8° + 弯曲（矢高约 2.2mm）
  const tiltX = Math.tan((0.8 * Math.PI) / 180);
  const bendK = (2.2 * 8) / (H * H); // z = k*y^2，边缘矢高 ~2.2mm

  let p = 0;
  for (let j = 0; j < ny; j++) {
    const y = (j / (ny - 1)) * H;
    for (let i = 0; i < nx; i++) {
      const x = (i / (nx - 1)) * W;
      const base = tiltX * (x - W / 2) + bendK * (y - H / 2) * (y - H / 2) - bendK * (H * H) / 12;
      const micro = (fbm(x * 0.09, y * 0.09, 4, opts.seed) - 0.5) * 0.16;
      const groove = grooveDepthAt(x, y, opts, chars).depth;
      const pit = pitDepthAt(x, y, pits);
      const z = base + micro - groove - pit;
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = z;
    }
  }

  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let q = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[q++] = a;
      indices[q++] = c;
      indices[q++] = b;
      indices[q++] = b;
      indices[q++] = c;
      indices[q++] = d;
    }
  }
  return { positions, indices, chars, pits, opts };
}

/**
 * 生成刻口真值掩膜（与高度场同分辨率，px/mm 对齐物理坐标）
 * @returns Uint8Array，1=刻槽内部（含槽壁），0=石面；另含每个像素所属字符序号 Int8Array
 */
export function generateGroundTruth(widthMm, heightMm, pxPerMm, opts, chars) {
  const W = Math.round(widthMm * pxPerMm);
  const H = Math.round(heightMm * pxPerMm);
  const mask = new Uint8Array(W * H);
  const owner = new Int16Array(W * H).fill(-1);
  const cell = 1 / pxPerMm;
  for (let py = 0; py < H; py++) {
    const y = (py + 0.5) * cell;
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) * cell;
      const g = grooveDepthAt(x, y, opts, chars);
      if (g.depth > 0) {
        mask[py * W + px] = 1;
        owner[py * W + px] = g.charIndex;
      }
    }
  }
  return { mask, owner, widthPx: W, heightPx: H, pxPerMm };
}
