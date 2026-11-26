import { db, uid } from '../db';
import { loadState, selectStele, state } from '../state';
import { h, mount, toast, formatBytes, formatNumber, modal } from '../ui/dom';
import type { Stele } from '../types';
import type { PageRenderer } from './types';
import { importScanFile } from '../geometry/importScan';
import { ensureSampleData } from '../sample';

export const renderArchive: PageRenderer = async (view, ctx) => {
  await loadState();
  let busy = false;

  const listCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, '碑刻列表'), h('button', { class: 'btn primary small', onclick: () => editStele() }, '+ 新建档案')));
  const detail = h('div', { class: 'card' });

  async function refresh(): Promise<void> {
    await loadState();
    renderList();
    renderDetail();
  }

  function renderList(): void {
    const body = h('div', { class: 'card-body stele-list' });
    if (!state.steles.length) {
      body.append(h('div', { class: 'empty-state' }, h('div', { class: 'big-icon' }, '碑'), h('h3', {}, '碑库为空'), h('p', {}, '可先生成程序测试样碑，或新建档案后导入 PLY / OBJ。'), h('button', {
        class: 'btn primary',
        onclick: async () => {
          await ensureSampleData((m) => toast(m, 'info', 1200));
          await refresh();
        },
      }, '生成测试样碑')));
    }
    for (const stele of state.steles) {
      const scans = state.scans.filter((s) => s.steleId === stele.id);
      body.append(h('button', {
        class: `stele-item ${state.currentSteleId === stele.id ? 'active' : ''}`,
        onclick: async () => { await selectStele(stele.id); renderList(); renderDetail(); },
      },
        h('h4', {}, h('span', {}, stele.name), h('span', { class: 'badge seal' }, `${scans.length} 次扫描`)),
        h('div', { class: 'stele-meta' },
          h('span', {}, `${stele.dynasty || '年代未填'} ${stele.era || ''}`),
          h('span', {}, `${stele.heightMm || '—'} × ${stele.widthMm || '—'} mm`),
          h('span', {}, stele.location || '位置未填'),
        ),
      ));
    }
    mount(listCard, h('div', { class: 'card-head' }, h('h3', {}, '碑刻列表'), h('button', { class: 'btn primary small', onclick: () => editStele() }, '+ 新建档案')), body);
  }

  function renderDetail(): void {
    const stele = state.steles.find((s) => s.id === state.currentSteleId);
    if (!stele) {
      mount(detail, h('div', { class: 'empty-state' }, h('h3', {}, '请选择或新建一块碑')), );
      return;
    }
    const scans = state.scans.filter((s) => s.steleId === stele.id).sort((a, b) => a.createdAt - b.createdAt);
    const fileInput = h('input', { type: 'file', accept: '.ply,.obj', multiple: true, style: 'display:none' }) as HTMLInputElement;
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.length || busy) return;
      busy = true;
      try {
        for (const file of Array.from(fileInput.files)) {
          toast(`正在解析 ${file.name}，大文件可能需要数十秒…`, 'info', 5000);
          const scan = await importScanFile(file, stele.id);
          await db.scans.put(scan);
          toast(`${file.name} 导入完成：${formatNumber(scan.faceCount)} 面`, 'success');
        }
        await refresh();
      } catch (error) {
        console.error(error);
        toast(error instanceof Error ? error.message : '导入失败', 'error', 7000);
      } finally {
        busy = false;
        fileInput.value = '';
      }
    });

    const form = buildSteleForm(stele);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      await db.steles.put(readSteleForm(form, stele));
      toast('碑刻档案已保存', 'success');
      await refresh();
    });

    mount(detail,
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', {}, stele.name), h('p', {}, '名称、年代、尺寸、位置与多次扫描归档')),
        h('div', { class: 'button-row' },
          h('button', { class: 'btn small', onclick: () => editStele(stele) }, '编辑'),
          h('button', { class: 'btn small blue', onclick: () => ctx.navigate('scan') }, '扫描处理'),
          h('button', { class: 'btn small primary', onclick: () => ctx.navigate('rubbing') }, '去做拓片'),
          h('button', { class: 'btn small', style: 'color:var(--danger);border-color:rgba(179,52,42,.45)', onclick: async () => {
            if (!confirm(`删除碑刻「${stele.name}」及其全部扫描、拓片稿和校勘记录？`)) return;
            const [scans, rubbings, compares] = await Promise.all([
              db.scans.byStele(stele.id), db.rubbings.byStele(stele.id), db.compares.list(),
            ]);
            await Promise.all([
              ...scans.map((s) => db.scans.delete(s.id)),
              ...rubbings.map((r) => db.rubbings.delete(r.id)),
              ...compares.filter((c) => c.steleId === stele.id).map((c) => db.compares.delete(c.id)),
              db.steles.delete(stele.id),
            ]);
            state.currentSteleId = undefined;
            state.currentScanId = undefined;
            await loadState();
            toast('碑刻及关联数据已删除', 'success');
            await refresh();
          } }, '删除'),
        ),
      ),
      h('div', { class: 'card-body grid', style: 'gap:16px' },
        form,
        h('div', {},
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px' },
            h('h4', { style: 'font-size:14px' }, `扫描版本（${scans.length}）`),
            h('div', { class: 'button-row' },
              h('button', { class: 'btn small', onclick: async () => {
                await ensureSampleData();
                await refresh();
              } }, '补造样例'),
              h('button', { class: 'btn small primary', onclick: () => fileInput.click() }, '导入 PLY/OBJ'),
            ),
          ),
          fileInput,
          h('div', { class: 'scan-list' },
            ...scans.map((scan) => h('div', { class: `scan-row ${state.currentScanId === scan.id ? 'active' : ''}` },
              h('div', {},
                h('strong', {}, scan.name),
                h('small', {}, `${new Date(scan.createdAt).toLocaleString('zh-CN')} · ${scan.source.toUpperCase()} · ${formatNumber(scan.vertexCount)} 顶点 / ${formatNumber(scan.faceCount)} 面`),
                h('div', { style: 'margin-top:5px;display:flex;gap:5px;flex-wrap:wrap' },
                  h('span', { class: 'badge' }, `${scan.widthMm.toFixed(0)}×${scan.heightMm.toFixed(0)} mm`),
                  scan.fit ? h('span', { class: 'badge good' }, `基准 RMS ${scan.fit.rmsMm.toFixed(3)} mm`) : h('span', { class: 'badge warn' }, '未拟合'),
                  scan.groundTruth ? h('span', { class: 'badge seal' }, '含精度真值') : null,
                ),
              ),
              h('div', { class: 'button-row' },
                h('button', { class: 'btn small', onclick: async () => { await selectStele(stele.id); const { selectScan } = await import('../state'); await selectScan(scan.id); ctx.navigate('scan'); } }, '处理'),
                h('button', { class: 'btn small primary', onclick: async () => { await selectStele(stele.id); const { selectScan } = await import('../state'); await selectScan(scan.id); ctx.navigate('rubbing'); } }, '拓片'),
                h('button', { class: 'icon-btn', title: '删除扫描', onclick: async () => {
                  if (!confirm(`删除扫描「${scan.name}」？`)) return;
                  await db.scans.delete(scan.id);
                  await refresh();
                } }, '删除'),
              ),
            )),
            scans.length ? null : h('div', { class: 'empty-state', style: 'min-height:160px' }, h('p', {}, '暂无扫描；可导入网格或生成程序样例。')),
          ),
        ),
      ),
    );
  }

  function editStele(existing?: Stele): void {
    const now = Date.now();
    const draft: Stele = existing ?? {
      id: uid('stele'), name: '', dynasty: '唐', era: '', yearNote: '', heightMm: 1000, widthMm: 450, thicknessMm: 180,
      location: '碑林', material: '青石', description: '', createdAt: now, updatedAt: now,
    };
    const form = buildSteleForm(draft, false);
    let api: { close: () => void } | undefined;
    const save = h('button', { class: 'btn primary', onclick: async () => {
      if (!form.reportValidity()) return;
      const saved = readSteleForm(form, draft);
      await db.steles.put(saved);
      await selectStele(saved.id);
      api?.close();
      toast('档案已保存', 'success');
      await refresh();
    } }, '保存');
    api = modal(existing ? '编辑碑刻档案' : '新建碑刻档案', form, h('div', { class: 'button-row' }, h('button', { class: 'btn', onclick: () => api?.close() }, '取消'), save));
  }

  view.append(
    h('div', { class: 'hero' },
      h('h2', {}, '贞石拓影'),
      h('p', {}, '本地优先的碑刻三维扫描与数字拓片工作台。网格、拓片稿、校勘图和出版 TIFF 均在浏览器内处理，原始数据保存在 IndexedDB。'),
      h('div', { class: 'feature-pill-row' },
        h('span', { class: 'badge seal' }, 'WebGL2 / 自写 GLSL'),
        h('span', { class: 'badge jade' }, '几百万面流畅旋转'),
        h('span', { class: 'badge blue' }, '600 DPI 分块 TIFF'),
        h('span', { class: 'badge' }, `IndexedDB ${formatBytes((await db.estimate())?.usage ?? 0)}`),
      ),
    ),
    h('div', { class: 'grid cols-2', style: 'grid-template-columns:minmax(300px,.72fr) minmax(0,1.28fr);align-items:start' }, listCard, detail),
  );
  await refresh();
};

function readSteleForm(form: HTMLFormElement, draft: Stele): Stele {
  const get = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? '';
  return {
    ...draft,
    name: get('name').trim() || '未命名碑刻',
    dynasty: get('dynasty'),
    era: get('era'),
    yearNote: get('yearNote'),
    heightMm: Number(get('heightMm')) || 0,
    widthMm: Number(get('widthMm')) || 0,
    thicknessMm: Number(get('thicknessMm')) || 0,
    material: get('material'),
    location: get('location'),
    description: get('description'),
    updatedAt: Date.now(),
  };
}

function buildSteleForm(stele: Stele, showSubmit = true): HTMLFormElement {
  const form = h('form', { class: 'form-grid' }) as HTMLFormElement;
  form.addEventListener('submit', (e) => e.preventDefault());
  const field = (name: keyof Stele, label: string, value: string | number, type = 'text', full = false, hint = '') =>
    h('label', { class: `field ${full ? 'full' : ''}` }, label, h('input', { type, name, value, required: name === 'name' }), hint ? h('span', { class: 'hint' }, hint) : null);
  form.append(
    field('name', '碑刻名称', stele.name, 'text', true),
    field('dynasty', '朝代', stele.dynasty),
    field('era', '年号 / 纪年', stele.era),
    field('heightMm', '高度 (mm)', stele.heightMm, 'number'),
    field('widthMm', '宽度 (mm)', stele.widthMm, 'number'),
    field('thicknessMm', '厚度 (mm)', stele.thicknessMm ?? '', 'number'),
    field('material', '石质', stele.material),
    field('location', '所在位置', stele.location, 'text', true),
    field('yearNote', '年代说明', stele.yearNote, 'text', true, '可填公元纪年、考证来源或测试数据说明'),
    h('label', { class: 'field full' }, '档案描述', h('textarea', { name: 'description' }, stele.description)),
    ...(showSubmit ? [h('div', { class: 'full button-row' }, h('button', { class: 'btn primary', type: 'submit' }, '保存档案'))] : []),
  );
  return form;
}
