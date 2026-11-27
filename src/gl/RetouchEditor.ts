import type { RetouchStroke } from '../types';
import { uid } from '../types';
import type { RubbingEngine } from './RubbingEngine';

/**
 * 补墨（拓工补墨）编辑栈：每次落笔为一条可逆操作。
 * 加深 strength>0 / 减淡 strength<0，全部通过重建补墨纹理生效。
 */
export class RetouchEditor {
  private strokes: RetouchStroke[] = [];
  private undoStack: RetouchStroke[][] = [];
  private redoStack: RetouchStroke[][] = [];

  constructor(private engine: RubbingEngine) {}

  setStrokes(s: RetouchStroke[]): void {
    this.strokes = s.map((x) => ({ ...x }));
    this.undoStack = [];
    this.redoStack = [];
    this.engine.rebuildRetouch(this.strokes);
  }

  list(): readonly RetouchStroke[] {
    return this.strokes;
  }

  addStroke(cxMm: number, cyMm: number, radiusMm: number, strength: number): RetouchStroke {
    this.undoStack.push(this.strokes.map((s) => ({ ...s })));
    this.redoStack = [];
    const stroke: RetouchStroke = { id: uid('stk'), cxMm, cyMm, radiusMm, strength };
    this.strokes.push(stroke);
    this.engine.rebuildRetouch(this.strokes);
    return stroke;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.strokes.map((s) => ({ ...s })));
    this.strokes = prev;
    this.engine.rebuildRetouch(this.strokes);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.strokes.map((s) => ({ ...s })));
    this.strokes = next;
    this.engine.rebuildRetouch(this.strokes);
    return true;
  }

  clear(): void {
    if (!this.strokes.length) return;
    this.undoStack.push(this.strokes.map((s) => ({ ...s })));
    this.redoStack = [];
    this.strokes = [];
    this.engine.clearRetouch();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}
