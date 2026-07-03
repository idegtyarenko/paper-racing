// Боковая панель: владеет её DOM-элементами и обновляет их по состоянию игры.

import { EditorState, canStepBack } from './editor';
import { GameState, Player } from './game';

const statusEl = document.querySelector('.status')!;

/** Основной указатель устройства — палец (телефон/планшет). */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const editButtons = document.getElementById('editButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const startRaceBtn = document.getElementById('startRace') as HTMLButtonElement;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const newTrackBtn = document.getElementById('newTrack') as HTMLButtonElement;
const winnerBanner = document.querySelector('.winner')!;
const winnerWho = winnerBanner.querySelector('.winner__title') as HTMLElement;
const p0El = document.getElementById('p0')!;
const p1El = document.getElementById('p1')!;

export interface PanelHandlers {
  onStartRace: () => void;
  onBack: () => void;
  onNewRace: () => void;
  onNewTrack: () => void;
}

export function bindButtons(h: PanelHandlers): void {
  startRaceBtn.addEventListener('click', h.onStartRace);
  backBtn.addEventListener('click', h.onBack);
  newRaceBtn.addEventListener('click', h.onNewRace);
  newTrackBtn.addEventListener('click', h.onNewTrack);
}

function div(className: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  return d;
}

/** Добавить текст с новой строки (<br> + текст). */
function addLine(target: HTMLElement, text: string): void {
  target.append(document.createElement('br'), text);
}

function playerInfo(p: Player, active: boolean, target: HTMLElement): void {
  target.classList.toggle('player-card--active', active);
  const dot = document.createElement('span');
  dot.className = 'player-card__dot';
  dot.style.background = p.color;
  const name = document.createElement('b');
  name.textContent = p.name;
  target.replaceChildren(dot, name);
  addLine(target, `скорость: (${p.vel.x}, ${p.vel.y})`);
  addLine(target, `аварии: ${p.crashes.length}`);
  if (p.skipTurns > 0) addLine(target, `⛔ пропуск ходов: ${p.skipTurns}`);
}

/** Отрисовка сообщения редактора: заметный «Шаг N из 4» + инструкция. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  statusEl.classList.add('status--step');
  const m = editor.message.match(/^(Шаг \d+ из \d+)\.\s*(.*)$/s);
  if (m) {
    statusEl.replaceChildren(div('status__badge', m[1]), div('status__body', m[2]));
  } else {
    statusEl.replaceChildren(div('status__body', editor.message));
  }
}

function showWinner(game: GameState): void {
  if (game.winner === 'draw') {
    winnerWho.textContent = 'Ничья!';
  } else {
    const w = game.players[game.winner!];
    const name = document.createElement('span');
    name.style.color = w.color;
    name.textContent = w.name;
    winnerWho.replaceChildren('Победил', document.createElement('br'), name);
  }
  winnerBanner.classList.add('winner--shown');
}

export function updatePanel(
  mode: 'edit' | 'race',
  editor: EditorState,
  game: GameState | null,
): void {
  if (mode === 'edit') {
    editButtons.hidden = false;
    raceButtons.hidden = true;
    renderEditStatus(editor);
    startRaceBtn.disabled = editor.phase !== 'ready';
    backBtn.disabled = !canStepBack(editor);
    return;
  }

  editButtons.hidden = true;
  raceButtons.hidden = false;
  statusEl.className = 'status';
  if (!game) return;

  playerInfo(game.players[0], game.phase === 'race' && game.current === 0, p0El);
  playerInfo(game.players[1], game.phase === 'race' && game.current === 1, p1El);

  if (game.phase === 'over') {
    showWinner(game);
    statusEl.textContent = '';
    return;
  }

  winnerBanner.classList.remove('winner--shown');
  const cur = game.players[game.current];
  const warn = game.pendingWinner === 0 && game.current === 1
    ? ' Игрок 1 уже финишировал — нужно закончить дальше за линией!'
    : '';
  const hint = coarsePointer
    ? 'Коснитесь точки, затем коснитесь её ещё раз для подтверждения.'
    : 'Кликните по одной из точек.';
  statusEl.textContent = `Ход: ${cur.name}. ${hint}${warn}`;
}
