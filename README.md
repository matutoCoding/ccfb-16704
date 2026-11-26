# 贞石拓影 · 碑刻数字拓片系统

浏览器本地运行的碑刻三维扫描、数字拓片、对比校勘与出版导出工作台。技术栈为 **TypeScript + Vite + WebGL2/原生 GLSL + IndexedDB**，不依赖后端，也不上传碑刻、照片或导出文件。

## 快速开始

```bash
npm install
npm run dev
```

打开终端输出的本地地址（默认 <http://127.0.0.1:5173>）。空碑库会自动生成一块程序样碑；也可以在“设置验收”中手动重建。

生产构建：

```bash
npm run build
npm run preview
```

几何、解析器和 TIFF 头的 Node 验收：

```bash
npm test
```

最近一次本机检查结果：

- `npm run build`：`tsc --noEmit` 与 Vite 构建通过。
- `npm test`：基准面拟合 RMS ≈ 0；0.4 mm 网格、360 个任意方向刻口样本的 600 DPI 综合 P95 偏差约 **0.191 mm**，低于 0.20 mm 容差。
- Headless Chrome 冒烟：六个页面可加载，程序样碑约 **360 万三角面**，拓片、自动配准、精度验收均无页面错误。
- 真实样碑验收面板实测：900 个清洁刻口样本，拓片阈值边界相对网格刻口边界平均 **0.044 mm**、RMS **0.054 mm**、600 DPI 综合 P95 **0.106 mm**、最大 **0.188 mm**，通过 `<0.20 mm` 指标。
- 96 DPI TIFF/ZIP 导出已用 Playwright 实测，并可用 `System.Drawing` 打开，尺寸/DPI 标签正确。

> 600 DPI 整碑为 10630 × 23622 px（450 mm × 1000 mm），未压缩灰度 TIFF 约 251 MB。页面采用 4096 px WebGL 分块、共享几何一次上传和直接灰度条带拷贝；实际 10 秒指标取决于 GPU/浏览器，可在“设置验收”中一键计时。

## 页面与需求对应

| 页面 | 已实现能力 |
| --- | --- |
| **碑刻档案** | 名称、朝代/年号、年代说明、高宽厚、位置、石质、描述；每块碑挂多次扫描；档案和关联扫描/拓片/校勘记录可删除。 |
| **扫描处理** | 导入 `.ply`（ASCII / binary little/big endian）和 `.obj`；自动 PCA 摆正、单位自动换算；抗差一次/二次基准面拟合，去除倾斜和低频弯曲；WebGL2 百万级三角面单索引绘制，支持旋转、缩放、自动旋转和复位。 |
| **拓片生成** | 基于物理毫米坐标的深度/曲率/坡度着墨，不是简单反色深度图；乌金拓、蝉翼拓预设；墨色、对比度、刻口阈值、边缘锐度、风化、纸纹、墨包肌理可调；风化坑/石花以高频几何和噪声保留；红/绿笔刷局部加深、减淡，笔画级撤销/重做（Ctrl/⌘+Z、Shift/Ctrl+Y）。 |
| **对比校勘** | 上传老拓片照片或一键生成带旋转、纸纹、噪点和旧化的示例老片；多尺度坐标搜索旋转、缩放和平移；对齐后做 Otsu 阈值、容差膨胀和连通域分析，红色“新泐”、蓝色“老片独有”区域高亮并列表面板。 |
| **出版导出** | 指定 DPI 导出灰度 TIFF（写 X/YResolution 与 ResolutionUnit=inch）；单字框编号、释字、自动按真值布框；批量单字 PNG ZIP 含 `coordinates.csv/json`；单字表 TIFF；坐标原点为碑面左上角，单位 mm。 |
| **设置验收** | 默认 DPI/分块尺寸、自动样例开关；IndexedDB 用量；WebGL 渲染器信息；真实样碑 GroundTruth 刻口偏差检测；600 DPI 整张 TIFF 计时与保存；清空/重建数据库。 |

## 程序测试数据

`src/geometry/procedural.ts` 会生成：

- 450 × 1000 mm 青石样碑；
- 900 × 2000 网格，约 180 万四边形 / **360 万三角面**；
- 20 个传统竖排阴刻楷书字，使用系统 KaiTi/STKaiti/SimKai/Noto Serif CJK 等字体栅格化，并做欧氏距离变换得到刻槽斜面；
- 整体倾斜、二次弯曲、扭转和小幅扫描波纹；
- 230 个点状坑、34 片不规则剥落；
- 第二次“复测”扫描在三个字附近追加 54 个新泐坑，供对比校勘识别。

字形 mask、坑洞参数和物理尺寸作为 `GroundTruth` 存入 IndexedDB。精度验收沿真值轮廓法线、避开风化坑邻域采样实际网格的双线性高度，先用轮廓外侧中位数建立局部表面基线，再比较：

1. 0.012 mm 微阈值找到的**网格刻口边界**；
2. 拓片 shader 使用的约 0.022 mm 着墨阈值边界；
3. 再叠加 600 DPI 像素量化项 `25.4/600 × 0.55`。

因此验收的是“拓片边界 vs 网格真实刻口边界”，而不是屏幕视觉估计。字体矢量轮廓到粗网格的离散化偏差会单独显示，不与网格刻口本身的重建精度混为一项。

## 关键实现

```text
src/
├─ db.ts                     IndexedDB stores 与结构化数据
├─ state.ts                  当前碑/扫描/工作稿状态
├─ sample.ts                 自动样例编排
├─ geometry/
│  ├─ parsers.ts             PLY/OBJ 解析、单位与 PCA 摆正
│  ├─ fit.ts                 IRLS 抗差平面/二次基准面拟合
│  ├─ procedural.ts          楷书、坑洞、弯曲和复测损伤生成
│  └─ acceptance.ts          GroundTruth 边界偏差验收
├─ render/
│  ├─ MeshViewer.ts          WebGL2 透视网格查看器
│  ├─ RubbingEngine.ts       高度编码 + GLSL 拓片 shader + 分块渲染
│  └─ editMask.ts            补墨/减淡矢量笔画 mask
├─ compare/
│  ├─ registration.ts        相似度配准、warp、Otsu、连通域
│  └─ samplePhoto.ts         旧拓片照片生成
├─ export/
│  ├─ tiff.ts                无压缩灰度 TIFF/DPI writer
│  ├─ zip.ts                 Store ZIP + CRC32
│  └─ publish.ts             分块整碑、单字、字表导出
└─ pages/                    六个应用页面
scripts/
├─ acceptance.ts             npm test
├─ browser-smoke.mjs         可选 Headless Chrome 冒烟
├─ rubbing-check.mjs         拓片像素检查/截图
└─ export-check.mjs          TIFF/ZIP 下载检查
```

## 数据与浏览器限制

- 所有数据保存在当前浏览器的 IndexedDB；大型 typed arrays 会占用数百 MB，浏览器可能要求持久存储授权。
- 推荐使用最新版 Chrome/Edge，并启用硬件加速。WebGL2 不可用时页面会显示错误。
- TIFF 当前使用无压缩灰度条带，优先保证出版兼容性和导出速度；文件较大。
- 自动配准面向碑刻/拓片常见的旋转、缩放和平移，不包含重度透视/非刚性形变；页面保留叠合透明度供人工复核。
- 本地诊断脚本默认调用 `C:\Program Files\Google\Chrome\Application\chrome.exe`，也可通过 `CHROME_PATH` 或修改 `playwright-core` 的 `executablePath` 使用其他浏览器。
