// Оркестрация: события мыши на canvas, переключение фаз редактор/гонка.

import './styles/index.css';
import { Vec, dist } from './geometry';
import { WORLD_W, WORLD_H, finalizeTrack, setWorldSize } from './track';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  pointerCancel,
  stepBack,
} from './editor';
import { GameState, Candidate, newGame, candidates, applyMove } from './game';
import { render, AppView } from './render';
import { bindButtons, updatePanel } from './ui';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.querySelector('.app__board')!;

let mode: 'edit' | 'race' = 'edit';
let editor = newEditor();
let game: GameState | null = null;
let cands: Candidate[] | null = null;
let hover: Candidate | null = null;
/** Тач: кандидат, выбранный первым касанием и ждущий подтверждения. */
let selected: Candidate | null = null;
/** Тач: позиция пальца (css-px canvas) во время прицеливания — включает лупу. */
let loupe: Vec | null = null;
let cellPx = 16;
/**
 * Размеры мира зафиксированы: поле уже «занято» (начата трасса / идёт гонка),
 * поэтому при повороте/ресайзе число клеток не пересчитывается — меняется лишь
 * cellPx. Пока false, число клеток подбирается под пропорции доски.
 */
let worldLocked = false;

/** Радиус попадания по кандидату в клетках: для пальца — не меньше 24 css-px. */
function touchTol(): number {
  return Math.max(0.45, 24 / cellPx);
}

function resize(): void {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (worldLocked) {
    // Мир зафиксирован (идёт рисование/гонка): число клеток не трогаем при
    // повороте/ресайзе — только вписываем фикс. сетку без искажений (letterbox).
    cellPx = Math.min(r.width / WORLD_W, r.height / WORLD_H);
  } else {
    // Поле ещё пустое: подбираем число клеток под пропорции доски. ceil (а не
    // min/floor) → сетка покрывает доску целиком, без пустой полосы.
    const cell = Math.max(12, Math.min(22, Math.min(r.width, r.height) / 30));
    setWorldSize(
      Math.max(8, Math.ceil(r.width / cell)),
      Math.max(8, Math.ceil(r.height / cell)),
    );
    cellPx = cell;
  }
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  redraw();
}

function redraw(): void {
  const app: AppView = { mode, editor, game, cands, hover, selected, loupe, cellPx };
  render(ctx, app);
}

function updateUI(): void {
  updatePanel(mode, editor, game);
}

function toScreen(e: PointerEvent): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function toWorld(e: PointerEvent): Vec {
  const p = toScreen(e);
  return {
    x: Math.max(0, Math.min(WORLD_W, p.x / cellPx)),
    y: Math.max(0, Math.min(WORLD_H, p.y / cellPx)),
  };
}

function refreshCands(): void {
  hover = null;
  selected = null;
  loupe = null;
  if (game && game.phase === 'race' && game.players[game.current].skipTurns === 0) {
    cands = candidates(game);
  } else {
    cands = null;
  }
}

function findCandidate(w: Vec, tol = 0.45): Candidate | null {
  if (!cands) return null;
  let best: Candidate | null = null;
  let bestD = tol;
  for (const c of cands) {
    if (c.blocked) continue;
    const d = dist(w, c.target);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** id активного тач-указателя: второй палец во время прицеливания игнорируем. */
let touchId: number | null = null;

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  // setPointerCapture кидает NotFoundError для уже неактивного указателя.
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {}
  const touch = e.pointerType === 'touch';
  if (touch) {
    if (touchId !== null) return;
    touchId = e.pointerId;
  }
  const w = toWorld(e);
  if (mode === 'edit') {
    // Пользователь коснулся доски — мир «занят», фиксируем число клеток.
    worldLocked = true;
    const arrowTol = touch ? Math.max(1.2, 24 / cellPx) : 1.2;
    pointerDown(editor, w, arrowTol);
    if (editor.phase === 'ready') { startRace(); return; }
    updateUI();
  } else if (game && game.phase === 'race') {
    if (touch) {
      // Прицеливание: показать лупу и подсветить ближайшего кандидата.
      hover = findCandidate(w, touchTol());
      loupe = toScreen(e);
    } else {
      const c = findCandidate(w);
      if (c) {
        applyMove(game, c);
        refreshCands();
        updateUI();
      }
    }
  }
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && e.pointerId !== touchId) return;
  const w = toWorld(e);
  if (mode === 'edit') {
    pointerMove(editor, w);
    redraw();
  } else if (e.pointerType === 'touch') {
    if (loupe) {
      hover = findCandidate(w, touchTol());
      loupe = toScreen(e);
      redraw();
    }
  } else {
    const c = findCandidate(w);
    if (c !== hover) {
      hover = c;
      redraw();
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  const touch = e.pointerType === 'touch';
  if (touch) {
    if (e.pointerId !== touchId) return;
    touchId = null;
  }
  if (mode === 'edit') {
    pointerMove(editor, toWorld(e));
    pointerUp(editor);
    updateUI();
    redraw();
  } else if (touch && game && game.phase === 'race') {
    // Отпускание пальца: тот же кандидат второй раз подряд — ход;
    // иначе — выбор с превью траектории; мимо кандидатов — сброс выбора.
    loupe = null;
    hover = null;
    const c = findCandidate(toWorld(e), touchTol());
    if (c && c === selected) {
      applyMove(game, c);
      refreshCands();
      updateUI();
    } else {
      selected = c;
    }
    redraw();
  }
});

canvas.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch' && e.pointerId !== touchId) return;
  touchId = null;
  loupe = null;
  hover = null;
  if (mode === 'edit') pointerCancel(editor);
  redraw();
});

function startRace(): void {
  if (editor.phase !== 'ready') return;
  const res = finalizeTrack(editor.outer!, editor.inner!, editor.finish!, editor.forward!);
  if ('error' in res) {
    editor.message = res.error;
    editor.error = true;
    updateUI();
    redraw();
    return;
  }
  game = newGame(res.track);
  mode = 'race';
  refreshCands();
  updateUI();
  redraw();
}

bindButtons({
  onBack: () => {
    stepBack(editor);
    updateUI();
    redraw();
  },
  onNewRace: () => {
    if (!game) return;
    game = newGame(game.track);
    refreshCands();
    updateUI();
    redraw();
  },
  onNewTrack: () => {
    mode = 'edit';
    game = null;
    cands = null;
    hover = null;
    editor = newEditor();
    // Снять фиксацию: новая трасса берёт пропорции под текущую ориентацию.
    worldLocked = false;
    updateUI();
    resize(); // пере-вывести мир под текущую ориентацию + redraw
  },
});

// ResizeObserver вместо window.resize: обёртка меняет размер и при смене
// раскладки (портрет/ландшафт на мобильных), а не только окна.
new ResizeObserver(resize).observe(wrap);
updateUI();
resize();
