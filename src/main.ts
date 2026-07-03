// Оркестрация: DOM, события мыши, переключение фаз редактор/гонка.

import { Vec, dist } from './geometry';
import { WORLD_W, WORLD_H, finalizeTrack } from './track';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  resetOuter,
  resetInner,
  resetFinish,
} from './editor';
import {
  GameState,
  Candidate,
  Player,
  newGame,
  candidates,
  applyMove,
  skipTurn,
  WIN_CROSSINGS,
} from './game';
import { render, AppView } from './render';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.getElementById('boardWrap')!;
const statusEl = document.getElementById('status')!;
const editButtons = document.getElementById('editButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const startRaceBtn = document.getElementById('startRace') as HTMLButtonElement;
const redrawOuterBtn = document.getElementById('redrawOuter') as HTMLButtonElement;
const redrawInnerBtn = document.getElementById('redrawInner') as HTMLButtonElement;
const redrawStartBtn = document.getElementById('redrawStart') as HTMLButtonElement;
const continueBtn = document.getElementById('continueBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const newTrackBtn = document.getElementById('newTrack') as HTMLButtonElement;
const p0El = document.getElementById('p0')!;
const p1El = document.getElementById('p1')!;

let mode: 'edit' | 'race' = 'edit';
let editor = newEditor();
let game: GameState | null = null;
let cands: Candidate[] | null = null;
let hover: Candidate | null = null;
let cellPx = 16;

function resize(): void {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  canvas.style.width = `${r.width}px`;
  canvas.style.height = `${r.height}px`;
  cellPx = Math.min(r.width / WORLD_W, r.height / WORLD_H);
  redraw();
}

function redraw(): void {
  const app: AppView = { mode, editor, game, cands, hover, cellPx };
  render(ctx, app);
}

function toWorld(e: PointerEvent): Vec {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / cellPx, y: (e.clientY - r.top) / cellPx };
}

function refreshCands(): void {
  hover = null;
  if (game && game.phase === 'race' && game.players[game.current].skipTurns === 0) {
    cands = candidates(game);
  } else {
    cands = null;
  }
}

function findCandidate(w: Vec): Candidate | null {
  if (!cands) return null;
  let best: Candidate | null = null;
  let bestD = 0.45;
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

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const w = toWorld(e);
  if (mode === 'edit') {
    pointerDown(editor, w);
    updateUI();
  } else if (game && game.phase === 'race') {
    const c = findCandidate(w);
    if (c) {
      applyMove(game, c);
      refreshCands();
      updateUI();
    }
  }
  redraw();
});

canvas.addEventListener('pointermove', (e) => {
  const w = toWorld(e);
  if (mode === 'edit') {
    pointerMove(editor, w);
    redraw();
  } else {
    const c = findCandidate(w);
    if (c !== hover) {
      hover = c;
      redraw();
    }
  }
});

canvas.addEventListener('pointerup', (e) => {
  if (mode === 'edit') {
    pointerMove(editor, toWorld(e));
    pointerUp(editor);
    updateUI();
    redraw();
  }
});

startRaceBtn.addEventListener('click', () => {
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
});

redrawOuterBtn.addEventListener('click', () => {
  resetOuter(editor);
  updateUI();
  redraw();
});
redrawInnerBtn.addEventListener('click', () => {
  resetInner(editor);
  updateUI();
  redraw();
});
redrawStartBtn.addEventListener('click', () => {
  resetFinish(editor);
  updateUI();
  redraw();
});

continueBtn.addEventListener('click', () => {
  if (!game) return;
  skipTurn(game);
  refreshCands();
  updateUI();
  redraw();
});

newRaceBtn.addEventListener('click', () => {
  if (!game) return;
  game = newGame(game.track);
  refreshCands();
  updateUI();
  redraw();
});

newTrackBtn.addEventListener('click', () => {
  mode = 'edit';
  game = null;
  cands = null;
  hover = null;
  editor = newEditor();
  updateUI();
  redraw();
});

function lapText(p: Player): string {
  if (p.crossings >= WIN_CROSSINGS) return 'финишировал 🏁';
  if (p.crossings >= 1) return 'круг идёт';
  return 'не стартовал';
}

function playerInfo(p: Player, active: boolean, el: HTMLElement): void {
  el.classList.toggle('active', active);
  const skip = p.skipTurns > 0 ? `<br>⛔ пропуск ходов: ${p.skipTurns}` : '';
  el.innerHTML =
    `<span class="dot" style="background:${p.color}"></span><b>${p.name}</b>` +
    `<br>скорость: (${p.vel.x}, ${p.vel.y})` +
    `<br>круг: ${lapText(p)}` +
    `<br>аварии: ${p.crashes.length}${skip}`;
}

function updateUI(): void {
  if (mode === 'edit') {
    editButtons.hidden = false;
    raceButtons.hidden = true;
    statusEl.textContent = editor.message;
    statusEl.classList.toggle('error', editor.error);
    startRaceBtn.disabled = editor.phase !== 'ready';
    redrawOuterBtn.disabled = !editor.outer && !editor.drawing;
    redrawInnerBtn.disabled = !editor.inner;
    redrawStartBtn.disabled = !editor.finish;
    return;
  }

  editButtons.hidden = true;
  raceButtons.hidden = false;
  statusEl.classList.remove('error');
  if (!game) return;

  playerInfo(game.players[0], game.phase === 'race' && game.current === 0, p0El);
  playerInfo(game.players[1], game.phase === 'race' && game.current === 1, p1El);

  if (game.phase === 'over') {
    statusEl.textContent =
      game.winner === 'draw'
        ? 'Ничья! Оба финишировали одинаково далеко за линией.'
        : `🏆 Победил ${game.players[game.winner!].name}!`;
    continueBtn.hidden = true;
    newRaceBtn.hidden = false;
    return;
  }

  newRaceBtn.hidden = false;
  const cur = game.players[game.current];
  if (cur.skipTurns > 0) {
    statusEl.textContent = `${cur.name} пропускает ход после аварии (осталось: ${cur.skipTurns}).`;
    continueBtn.hidden = false;
  } else {
    const warn = game.pendingWinner === 0 && game.current === 1
      ? ' Игрок 1 уже финишировал — нужно закончить дальше за линией!'
      : '';
    statusEl.textContent = `Ход: ${cur.name}. Кликните по одной из точек.${warn}`;
    continueBtn.hidden = true;
  }
}

window.addEventListener('resize', resize);
updateUI();
resize();
