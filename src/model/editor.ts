// Фаза рисования трассы: стейт-машина center → adjust → finish → direction → ready.
// Пользователь проводит осевую линию, кромки откладываются автоматически, после
// чего их можно подправить перетаскиванием.

import {
  Vec,
  Polyline,
  add,
  sub,
  scale,
  normalize,
  dist,
  lerp,
  distPointToSegment,
  selfIntersectsClosed,
  polygonArea,
} from '../geometry';
import { FinishLine, processStroke, clipFinishLine } from './track';
import {
  WidthModel,
  generateEdges,
  rebuildEdges,
  pickEdge,
  applyEdgeDrag,
} from './centerline';
import { strings } from '../strings';
import { MIN_CENTER_AREA } from '../config';

export type EditorPhase = 'center' | 'adjust' | 'finish' | 'direction' | 'ready';

export interface Arrow {
  from: Vec;
  tip: Vec;
  forward: Vec;
}

export interface EditorState {
  phase: EditorPhase;
  /** Осевая линия трассы (замкнутая полилиния). */
  center: Polyline | null;
  /** Модель ширины: нормали и смещения кромок вдоль осевой. */
  width: WidthModel | null;
  outer: Polyline | null;
  inner: Polyline | null;
  finish: FinishLine | null;
  forward: Vec | null;
  arrows: [Arrow, Arrow] | null;
  /** Сырой freehand-штрих во время рисования осевой. */
  stroke: Vec[];
  drawing: boolean;
  /** Протягивание финишной линии. */
  dragStart: Vec | null;
  dragEnd: Vec | null;
  /** Тюнинг кромок: какую сторону и вершину тянем. */
  dragEdge: 'outer' | 'inner' | null;
  dragIndex: number | null;
  message: string;
  error: boolean;
}

const MSG: Record<EditorPhase, string> = strings.editor.step;

export function newEditor(): EditorState {
  return {
    phase: 'center',
    center: null,
    width: null,
    outer: null,
    inner: null,
    finish: null,
    forward: null,
    arrows: null,
    stroke: [],
    drawing: false,
    dragStart: null,
    dragEnd: null,
    dragEdge: null,
    dragIndex: null,
    message: MSG.center,
    error: false,
  };
}

function setPhase(st: EditorState, phase: EditorPhase): void {
  st.phase = phase;
  st.message = MSG[phase];
  st.error = false;
}

function fail(st: EditorState, message: string): void {
  st.message = message;
  st.error = true;
}

export function pointerDown(st: EditorState, p: Vec, tol = 1.2): void {
  if (st.phase === 'center') {
    st.drawing = true;
    st.stroke = [p];
  } else if (st.phase === 'adjust' && st.width) {
    const pick = pickEdge(st.width, p, tol);
    if (pick) {
      st.dragEdge = pick.edge;
      st.dragIndex = pick.index;
    }
  } else if (st.phase === 'finish' && st.width) {
    st.dragStart = p;
    previewFinish(st, p);
  } else if (st.phase === 'direction' && st.arrows) {
    for (const arrow of st.arrows) {
      if (distPointToSegment(p, arrow.from, arrow.tip) < tol) {
        st.forward = arrow.forward;
        setPhase(st, 'ready');
        return;
      }
    }
  }
}

export function pointerMove(st: EditorState, p: Vec): void {
  if (st.drawing) {
    const last = st.stroke[st.stroke.length - 1];
    if (!last || dist(last, p) > 0.15) st.stroke.push(p);
  } else if (
    st.phase === 'adjust' &&
    st.width &&
    st.dragEdge !== null &&
    st.dragIndex !== null
  ) {
    if (applyEdgeDrag(st.width, st.dragEdge, st.dragIndex, p)) {
      const e = rebuildEdges(st.width);
      st.outer = e.outer;
      st.inner = e.inner;
    }
  } else if (st.phase === 'finish' && st.dragStart && st.width) {
    st.dragStart = p;
    previewFinish(st, p);
  }
}

export function pointerUp(st: EditorState): void {
  if (st.drawing) {
    st.drawing = false;
    const raw = st.stroke;
    st.stroke = [];
    const res = processStroke(raw);
    if ('error' in res) {
      fail(st, res.error);
      return;
    }
    if (st.phase === 'center') {
      if (selfIntersectsClosed(res.poly)) {
        fail(st, strings.editor.errors.selfCross);
        return;
      }
      if (polygonArea(res.poly) < MIN_CENTER_AREA) {
        fail(st, strings.editor.errors.tooSmall);
        return;
      }
      const gen = generateEdges(res.poly);
      if ('error' in gen) {
        fail(st, gen.error);
        return;
      }
      st.center = res.poly;
      st.width = gen.model;
      st.outer = gen.outer;
      st.inner = gen.inner;
      setPhase(st, 'adjust');
    }
  } else if (st.phase === 'adjust') {
    st.dragEdge = null;
    st.dragIndex = null;
  } else if (st.phase === 'finish' && st.dragStart && st.width) {
    const p = st.dragStart;
    st.dragStart = null;
    st.dragEnd = null;
    const res = clipPerpAt(st.width, p, st.outer!, st.inner!);
    if ('error' in res) {
      st.finish = null;
      fail(
        st,
        res.error === 'narrow'
          ? strings.editor.errors.finishNarrow
          : strings.editor.errors.finishMiss,
      );
      return;
    }
    st.finish = res.finish;
    computeArrows(st);
    setPhase(st, 'direction');
  }
}

/** Направление поперёк трассы в точке p — нормаль ближайшей вершины осевой. */
function perpDirAt(width: WidthModel, p: Vec): Vec {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < width.center.length; i++) {
    const d = dist(p, width.center[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return width.outNormal[best];
}

/**
 * Финишная линия через точку p, перпендикулярная осевой: берём нормаль
 * ближайшей вершины осевой и обрезаем короткий отрезок вдоль неё по кромкам.
 */
function clipPerpAt(
  width: WidthModel,
  p: Vec,
  outer: Polyline,
  inner: Polyline,
): ReturnType<typeof clipFinishLine> {
  const d = perpDirAt(width, p);
  return clipFinishLine(sub(p, d), add(p, d), outer, inner);
}

/** Обновить предпросмотр финишной линии по текущей точке касания. */
function previewFinish(st: EditorState, p: Vec): void {
  const res = clipPerpAt(st.width!, p, st.outer!, st.inner!);
  st.finish = 'error' in res ? null : res.finish;
  st.error = false;
}

/** Прерывание жеста (pointercancel): сбросить незавершённый штрих/линию/драг. */
export function pointerCancel(st: EditorState): void {
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  if (st.phase === 'finish') st.finish = null;
}

/** Подтвердить кромки и перейти к рисованию старт/финиша. */
export function confirmEdges(st: EditorState): void {
  if (st.phase === 'adjust') setPhase(st, 'finish');
}

function computeArrows(st: EditorState): void {
  const f = st.finish!;
  const m = lerp(f.a, f.b, 0.5);
  const d = normalize(sub(f.b, f.a));
  const n = { x: -d.y, y: d.x };
  st.arrows = [
    { from: add(m, scale(n, 1.2)), tip: add(m, scale(n, 4)), forward: n },
    { from: add(m, scale(n, -1.2)), tip: add(m, scale(n, -4)), forward: scale(n, -1) },
  ];
}

export function resetCenter(st: EditorState): void {
  st.center = null;
  st.width = null;
  st.outer = null;
  st.inner = null;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  setPhase(st, 'center');
}

/** Вернуться к тюнингу кромок, сохранив осевую и сгенерированное полотно. */
export function resetAdjust(st: EditorState): void {
  if (!st.width) return;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.dragStart = null;
  st.dragEnd = null;
  st.dragEdge = null;
  st.dragIndex = null;
  setPhase(st, 'adjust');
}

export function resetFinish(st: EditorState): void {
  if (!st.inner) return;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.dragStart = null;
  st.dragEnd = null;
  setPhase(st, 'finish');
}

/** Единый шаг назад по стейт-машине рисования. */
export function stepBack(st: EditorState): void {
  switch (st.phase) {
    case 'adjust':
      resetCenter(st);
      break;
    case 'finish':
      resetAdjust(st);
      break;
    case 'direction':
      resetFinish(st);
      break;
    case 'ready':
      st.forward = null;
      setPhase(st, 'direction');
      break;
    // 'center' — это первый шаг, назад некуда.
  }
}

/** Можно ли шагнуть назад из текущей фазы. */
export function canStepBack(st: EditorState): boolean {
  return st.phase !== 'center';
}

/**
 * Готовый editor-«снимок» из уже построенной трассы — для превью в лобби у гостя,
 * который трассу не рисовал. Фаза `ready` рисует кромки и финиш без стрелок/тюнинга.
 */
export function editorFromTrack(t: {
  outer: Polyline;
  inner: Polyline;
  finish: FinishLine;
  forward: Vec;
}): EditorState {
  const st = newEditor();
  st.phase = 'ready';
  st.outer = t.outer;
  st.inner = t.inner;
  st.finish = t.finish;
  st.forward = t.forward;
  return st;
}
