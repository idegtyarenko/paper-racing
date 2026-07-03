// Оркестрация: события мыши на canvas, переключение фаз редактор/гонка.

import './styles/index.css';
import { Vec, dist } from './geometry';
import { WORLD_W, WORLD_H, finalizeTrack } from './track';
import {
  newEditor,
  pointerDown,
  pointerMove,
  pointerUp,
  stepBack,
} from './editor';
import { GameState, Candidate, newGame, candidates, applyMove } from './game';
import { render, AppView } from './render';
import { bindButtons, updatePanel } from './ui';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.getElementById('boardWrap')!;

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

function updateUI(): void {
  updatePanel(mode, editor, game);
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

bindButtons({
  onStartRace: () => {
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
  },
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
    updateUI();
    redraw();
  },
});

window.addEventListener('resize', resize);
updateUI();
resize();
