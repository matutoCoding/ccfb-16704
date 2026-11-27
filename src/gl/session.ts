// WebGL2 引擎单例会话：canvas 与引擎随当前扫描切换
import type { HeightField, RetouchStroke, RubbingParams } from '../types';
import { RubbingEngine } from './RubbingEngine';
import { RetouchEditor } from './RetouchEditor';

interface Session {
  canvas: HTMLCanvasElement;
  engine: RubbingEngine;
  editor: RetouchEditor;
  scanId: string;
}

let current: Session | null = null;

export function getOrCreateSession(canvas: HTMLCanvasElement, scanId: string): Session {
  if (current && current.scanId === scanId && current.canvas === canvas) return current;
  if (current) {
    current.engine.dispose();
    current = null;
  }
  const engine = new RubbingEngine(canvas);
  const editor = new RetouchEditor(engine);
  current = { canvas, engine, editor, scanId };
  return current;
}

export function getSession(): Session | null {
  return current;
}

export function closeSession(): void {
  if (current) {
    current.engine.dispose();
    current = null;
  }
}

export interface PreviewRequest {
  params: RubbingParams;
  strokes: RetouchStroke[];
  inkColor?: string;
  paperColor?: string;
}

export function previewOnCanvas(canvas: HTMLCanvasElement, hf: HeightField, req: PreviewRequest): Session {
  const session = getOrCreateSession(canvas, hf.widthPx + ':' + hf.heightPx);
  session.engine.setHeightField(hf);
  session.editor.setStrokes(req.strokes);
  session.engine.renderPreview(canvas, {
    params: req.params,
    strokes: req.strokes,
    inkColor: req.inkColor,
    paperColor: req.paperColor,
  });
  return session;
}
