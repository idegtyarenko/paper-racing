// Фаза рисования трассы: стейт-машина outer → inner → finish → direction → ready.

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
} from './geometry';
import {
  FinishLine,
  processStroke,
  validateOuter,
  validateInner,
  clipFinishLine,
} from './track';

export type EditorPhase = 'outer' | 'inner' | 'finish' | 'direction' | 'ready';

export interface Arrow {
  from: Vec;
  tip: Vec;
  forward: Vec;
}

export interface EditorState {
  phase: EditorPhase;
  outer: Polyline | null;
  inner: Polyline | null;
  finish: FinishLine | null;
  forward: Vec | null;
  arrows: [Arrow, Arrow] | null;
  /** Сырой freehand-штрих во время рисования края. */
  stroke: Vec[];
  drawing: boolean;
  /** Протягивание финишной линии. */
  dragStart: Vec | null;
  dragEnd: Vec | null;
  message: string;
  error: boolean;
}

const MSG: Record<EditorPhase, string> = {
  outer:
    'Шаг 1 из 5. Обведи ВНЕШНИЙ бортик трассы — одним росчерком, не отрывая ' +
    'руки. Мышью или пальцем.',
  inner:
    'Шаг 2 из 5. Теперь ВНУТРЕННИЙ бортик — обведи его внутри внешнего. ' +
    'Между ними и помчат болиды.',
  finish:
    'Шаг 3 из 5. Черкни линию старт/финиш поперёк полотна: начни у одного ' +
    'бортика, протяни и отпусти у другого.',
  direction: 'Шаг 4 из 5. Куда мчим? Ткни в зелёную стрелку — задай направление круга.',
  ready: 'Трасса готова! Осталось выбрать, сколько болидов на старте.',
};

export function newEditor(): EditorState {
  return {
    phase: 'outer',
    outer: null,
    inner: null,
    finish: null,
    forward: null,
    arrows: null,
    stroke: [],
    drawing: false,
    dragStart: null,
    dragEnd: null,
    message: MSG.outer,
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

export function pointerDown(st: EditorState, p: Vec, arrowTol = 1.2): void {
  if (st.phase === 'outer' || st.phase === 'inner') {
    st.drawing = true;
    st.stroke = [p];
  } else if (st.phase === 'finish') {
    st.dragStart = p;
    st.dragEnd = p;
  } else if (st.phase === 'direction' && st.arrows) {
    for (const arrow of st.arrows) {
      if (distPointToSegment(p, arrow.from, arrow.tip) < arrowTol) {
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
  } else if (st.phase === 'finish' && st.dragStart) {
    st.dragEnd = p;
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
    if (st.phase === 'outer') {
      const err = validateOuter(res.poly);
      if (err) {
        fail(st, err);
        return;
      }
      st.outer = res.poly;
      setPhase(st, 'inner');
    } else if (st.phase === 'inner' && st.outer) {
      const err = validateInner(res.poly, st.outer);
      if (err) {
        fail(st, err);
        return;
      }
      st.inner = res.poly;
      setPhase(st, 'finish');
    }
  } else if (st.phase === 'finish' && st.dragStart && st.dragEnd) {
    const a = st.dragStart;
    const b = st.dragEnd;
    st.dragStart = null;
    st.dragEnd = null;
    if (dist(a, b) < 1) {
      fail(st, 'Черта коротковата — протяни её через всё полотно.');
      return;
    }
    const res = clipFinishLine(a, b, st.outer!, st.inner!);
    if ('error' in res) {
      fail(
        st,
        res.error === 'narrow'
          ? 'Здесь полотно узкое — проведи старт/финиш там, где пошире.'
          : 'Старт/финиш должен рассекать полотно от бортика до бортика.',
      );
      return;
    }
    st.finish = res.finish;
    computeArrows(st);
    setPhase(st, 'direction');
  }
}

/** Прерывание жеста (pointercancel): сбросить незавершённый штрих/линию. */
export function pointerCancel(st: EditorState): void {
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
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

export function resetOuter(st: EditorState): void {
  st.outer = null;
  st.inner = null;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  setPhase(st, 'outer');
}

export function resetInner(st: EditorState): void {
  if (!st.outer) return;
  st.inner = null;
  st.finish = null;
  st.forward = null;
  st.arrows = null;
  st.drawing = false;
  st.stroke = [];
  st.dragStart = null;
  st.dragEnd = null;
  setPhase(st, 'inner');
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
    case 'inner':
      resetOuter(st);
      break;
    case 'finish':
      resetInner(st);
      break;
    case 'direction':
      resetFinish(st);
      break;
    case 'ready':
      st.forward = null;
      setPhase(st, 'direction');
      break;
    // 'outer' — это первый шаг, назад некуда.
  }
}

/** Можно ли шагнуть назад из текущей фазы. */
export function canStepBack(st: EditorState): boolean {
  return st.phase !== 'outer';
}
