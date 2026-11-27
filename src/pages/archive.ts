// 碑刻档案页：档案 CRUD + 每碑挂多次扫描
import { repo } from '../db/repo';
import { hideProgress, showProgress, store, toast } from '../state';
import type { ScanRecord, SteleRecord } from '../types';
import { newScanId, newSteleId } from '../db/repo';
import { clear, h } from '../ui/dom';
import { scanStats } from '../geometry/pipeline';

export async function renderArchivePage(root: HTMLElement): Promise<void> {
  clear(root);
  const steles = await repo.listSteles();
  const scans = await repo.listScans();
  store.update({ steles, scans });

  const sidebar = h('div', { class: 'sidebar' });
  const stage = h('div', { class: 'stage' });
  root.append(sidebar, stage);

  const form = h('div', { class: 'card' });
  form.append(
    h('h3', { textContent: '新建碑刻档案' }),
    field('名称', 'text', '例：大秦景教流行中国碑'),
    field('年代', 'text', '例：唐建中二年（781）'),
    field('高度(mm)', 'number', '1800'),
    field('宽度(mm)', 'number', '850'),
    field('厚度(mm)', 'number', '280'),
    field('所在位置', 'text', '例：西安碑林博物馆'),
  );
  const note = h('textarea', { placeholder: '备注' }) as HTMLTextAreaElement;
  const inputs = form.querySelectorAll('input');
  form.append(
    note,
    h('div', { class: 'btn-row', style: 'margin-top:10px' },
      h('button', {
        class: 'btn', textContent: '保存档案', onclick: async () => {
          const name = (inputs[0] as HTMLInputElement).value.trim();
          if (!name) return toast('请填写名称');
          const rec: SteleRecord = {
            id: newSteleId(),
            name,
            dynasty: (inputs[1] as HTMLInputElement).value.trim(),
            heightMm: Number((inputs[2] as HTMLInputElement).value) || 0,
            widthMm: Number((inputs[3] as HTMLInputElement).value) || 0,
            thicknessMm: Number((inputs[4] as HTMLInputElement).value) || 0,
            location: (inputs[5] as HTMLInputElement).value.trim(),
            note: note.value,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          await repo.saveStele(rec);
          toast('档案已保存');
          renderArchivePage(root);
        },
      })),
  );
  sidebar.append(form);

  const listCard = h('div', { class: 'card' }, h('h3', { textContent: `档案列表（${steles.length}）` }));
  if (!steles.length) {
    listCard.append(h('div', { class: 'muted', textContent: '暂无档案，请在上方新建。' }));
  }
  for (const s of steles) {
    const item = h('div', {
      class: 'list-item' + (store.get().currentSteleId === s.id ? ' selected' : ''),
      onclick: () => selectStele(stage, s.id),
    },
      h('div', { class: 'title', textContent: s.name }),
      h('div', { class: 'sub', textContent: `${s.dynasty || '年代不详'} · ${s.heightMm}×${s.widthMm}mm · ${s.location || '位置未记'}` }),
      h('div', { class: 'sub', textContent: `扫描 ${scans.filter((x) => x.steleId === s.id).length} 次` }),
    );
    listCard.append(item);
  }
  sidebar.append(listCard);

  stage.append(h('div', { class: 'empty' },
    h('div', { style: 'font-size:42px' }, '🗿'),
    h('div', { textContent: '从左侧选择或新建一块碑' })));

  if (store.get().currentSteleId) selectStele(stage, store.get().currentSteleId!);
}

function field(label: string, type: string, placeholder: string): HTMLElement {
  return h('div', { class: 'row' },
    h('label', { textContent: label }),
    h('input', { type, placeholder }) as HTMLInputElement);
}

async function selectStele(stage: HTMLElement, steleId: string): Promise<void> {
  store.update({ currentSteleId: steleId });
  const stele = (await repo.listSteles()).find((s) => s.id === steleId);
  const scans = await repo.listScans(steleId);
  if (!stele) return;
  clear(stage);
  const wrap = h('div', { class: 'scroll', style: 'width:100%' });
  const card = h('div', { class: 'card', style: 'max-width:760px' });
  card.append(
    h('div', { class: 'section-title', textContent: stele.name }),
    metric('年代', stele.dynasty || '—'),
    metric('尺寸', `${stele.heightMm} × ${stele.widthMm} × ${stele.thicknessMm} mm`),
    metric('所在位置', stele.location || '—'),
    metric('备注', stele.note || '—'),
    h('div', { class: 'btn-row', style: 'margin-top:12px' },
      h('button', {
        class: 'btn', textContent: '前往扫描处理', onclick: () => store.update({ route: 'scan' }),
      }),
      h('button', {
        class: 'btn ghost', textContent: '删除档案', onclick: async () => {
          if (!confirm(`确定删除「${stele.name}」及其全部扫描数据？`)) return;
          const prog = showProgress('删除中…', 0.5);
          await repo.deleteStele(stele.id);
          hideProgress();
          prog.remove();
          store.update({ currentSteleId: null, currentScanId: null });
          toast('已删除');
          renderArchivePage(stage.parentElement!);
        },
      })),
  );
  wrap.append(card);

  const scanCard = h('div', { class: 'card', style: 'max-width:760px' }, h('h3', { textContent: `扫描记录（${scans.length}）` }));
  if (!scans.length) scanCard.append(h('div', { class: 'muted', textContent: '尚无扫描，去「扫描处理」页导入 PLY/OBJ。' }));
  for (const sc of scans) {
    scanCard.append(h('div', { class: 'list-item' },
      h('div', { class: 'title', textContent: sc.label }),
      h('div', { class: 'sub', textContent: scanStats(sc) }),
      h('div', { class: 'sub', textContent: `基准面拟合 RMS ${sc.planeFitRmsMm.toFixed(3)}mm · ${new Date(sc.createdAt).toLocaleString()}` }),
      h('div', { class: 'btn-row', style: 'margin-top:6px' },
        h('button', {
          class: 'btn ghost', textContent: '打开拓片', onclick: () => {
            store.update({ currentScanId: sc.id, route: 'rubbing' });
          },
        }),
        h('button', {
          class: 'btn danger', textContent: '删除', onclick: async () => {
            if (!confirm('删除该扫描及其高度场、补墨与单字数据？')) return;
            await repo.deleteScan(sc.id);
            if (store.get().currentScanId === sc.id) store.update({ currentScanId: null });
            toast('已删除');
            selectStele(stage, steleId);
          },
        })),
    ));
  }
  wrap.append(scanCard);
  stage.append(wrap);
}

function metric(k: string, v: string): HTMLElement {
  return h('div', { class: 'metric' }, h('span', { textContent: k }), h('b', { textContent: v }));
}

// 供扫描页创建扫描记录使用
export async function createScanStub(steleId: string, label: string, partial: Partial<ScanRecord>): Promise<ScanRecord> {
  const rec: ScanRecord = {
    id: newScanId(),
    steleId,
    label,
    sourceName: partial.sourceName ?? '',
    format: partial.format ?? 'ply',
    vertexCount: partial.vertexCount ?? 0,
    faceCount: partial.faceCount ?? 0,
    widthMm: partial.widthMm ?? 0,
    heightMm: partial.heightMm ?? 0,
    planeFitRmsMm: partial.planeFitRmsMm ?? 0,
    createdAt: Date.now(),
  };
  await repo.saveScan(rec);
  return rec;
}
