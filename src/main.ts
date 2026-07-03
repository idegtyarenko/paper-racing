// Оркестрация: DOM, события мыши, переключение фаз редактор/гонка.

import { Vec, dist } from './geometry';
import { WORLD_W, WORLD_H, finalizeTrack } from './track';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  stepBack,
  canStepBack,
} from './editor';
import {
  GameState,
  Candidate,
  Player,
  newGame,
  candidates,
  applyMove,
} from './game';
import { render, AppView } from './render';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.getElementById('boardWrap')!;
const statusEl = document.getElementById('status')!;
const editButtons = document.getElementById('editButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const startRaceBtn = document.getElementById('startRace') as HTMLButtonElement;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const newTrackBtn = document.getElementById('newTrack') as HTMLButtonElement;
const winnerBanner = document.getElementById('winnerBanner')!;
const winnerWho = winnerBanner.querySelector('.who') as HTMLElement;
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

backBtn.addEventListener('click', () => {
  stepBack(editor);
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

function playerInfo(p: Player, active: boolean, el: HTMLElement): void {
  el.classList.toggle('active', active);
  const skip = p.skipTurns > 0 ? `<br>⛔ пропуск ходов: ${p.skipTurns}` : '';
  el.innerHTML =
    `<span class="dot" style="background:${p.color}"></span><b>${p.name}</b>` +
    `<br>скорость: (${p.vel.x}, ${p.vel.y})` +
    `<br>аварии: ${p.crashes.length}${skip}`;
}

/** Отрисовка сообщения редактора: заметный «Шаг N из 4» + инструкция. */
function renderEditStatus(): void {
  statusEl.className = '';
  if (editor.error) {
    statusEl.classList.add('error');
    statusEl.textContent = editor.message;
    return;
  }
  statusEl.classList.add('step');
  const m = editor.message.match(/^(Шаг \d+ из \d+)\.\s*(.*)$/s);
  if (m) {
    statusEl.innerHTML =
      `<div class="step-badge">${m[1]}</div><div class="step-body">${m[2]}</div>`;
  } else {
    statusEl.innerHTML = `<div class="step-body">${editor.message}</div>`;
  }
}

function updateUI(): void {
  if (mode === 'edit') {
    editButtons.hidden = false;
    raceButtons.hidden = true;
    renderEditStatus();
    startRaceBtn.disabled = editor.phase !== 'ready';
    backBtn.disabled = !canStepBack(editor);
    return;
  }

  editButtons.hidden = true;
  raceButtons.hidden = false;
  statusEl.className = '';
  if (!game) return;

  playerInfo(game.players[0], game.phase === 'race' && game.current === 0, p0El);
  playerInfo(game.players[1], game.phase === 'race' && game.current === 1, p1El);

  if (game.phase === 'over') {
    if (game.winner === 'draw') {
      winnerWho.textContent = 'Ничья!';
    } else {
      const w = game.players[game.winner!];
      winnerWho.innerHTML =
        `Победил<br><span style="color:${w.color}">${w.name}</span>`;
    }
    winnerBanner.classList.add('show');
    statusEl.textContent = '';
    newRaceBtn.hidden = false;
    return;
  }

  winnerBanner.classList.remove('show');
  newRaceBtn.hidden = false;
  const cur = game.players[game.current];
  const warn = game.pendingWinner === 0 && game.current === 1
    ? ' Игрок 1 уже финишировал — нужно закончить дальше за линией!'
    : '';
  statusEl.textContent = `Ход: ${cur.name}. Кликните по одной из точек.${warn}`;
}

window.addEventListener('resize', resize);
updateUI();
resize();
