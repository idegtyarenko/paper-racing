// Боковая панель: владеет её DOM-элементами и обновляет их по состоянию игры.

import { EditorState, canStepBack } from './editor';
import { GameState, Player } from './game';
import { strings } from './strings';

const statusEl = document.querySelector('.status')!;

/** Основной указатель устройства — палец (телефон/планшет). */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const editButtons = document.getElementById('editButtons')!;
const playersButtons = document.getElementById('playersButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
const playersBackBtn = document.getElementById('playersBack') as HTMLButtonElement;
const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const confirmMoveBtn = document.getElementById('confirmMove') as HTMLButtonElement;
const overlay = document.getElementById('overlay')!;
const rulesSheet = document.getElementById('rulesSheet')!;
const raceDialog = document.getElementById('raceDialog')!;
const dlgSameTrack = document.getElementById('dlgSameTrack') as HTMLButtonElement;
const dlgNewTrack = document.getElementById('dlgNewTrack') as HTMLButtonElement;
const winnerBanner = document.querySelector('.winner')!;
const winnerWho = winnerBanner.querySelector('.winner__title') as HTMLElement;
const playerCount = document.getElementById('playerCount')!;

/** Режим панели: рисование трассы, выбор числа игроков, гонка. */
export type PanelMode = 'edit' | 'players' | 'race';

export interface PanelHandlers {
  /** Шаг назад в редакторе трассы. */
  onBack: () => void;
  /** Подтвердить кромки (фаза adjust) и перейти к старт/финишу. */
  onNext: () => void;
  onConfirmMove: () => void;
  /** «Та же трасса» — перейти к повторному выбору числа игроков. */
  onChooseSameTrack: () => void;
  onNewTrack: () => void;
  /** Назад из шага выбора игроков. */
  onPlayersBack: () => void;
  /** Выбрано число игроков — сразу стартуем гонку. */
  onPlayerCount: (n: number) => void;
}

/** Показать/спрятать плавающую кнопку подтверждения хода (тач-прицеливание). */
export function showConfirmMove(show: boolean): void {
  confirmMoveBtn.hidden = !show;
}

/** Показать одну шторку оверлея, спрятав остальные. */
function openSheet(sheet: HTMLElement): void {
  rulesSheet.hidden = true;
  raceDialog.hidden = true;
  sheet.hidden = false;
  overlay.hidden = false;
}

function closeOverlay(): void {
  overlay.hidden = true;
}

export function bindButtons(h: PanelHandlers): void {
  backBtn.addEventListener('click', h.onBack);
  nextBtn.addEventListener('click', h.onNext);
  playersBackBtn.addEventListener('click', h.onPlayersBack);
  confirmMoveBtn.addEventListener('click', h.onConfirmMove);
  playerCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) h.onPlayerCount(Number(btn.dataset.count));
    });
  });
  helpBtn.addEventListener('click', () => openSheet(rulesSheet));
  newRaceBtn.addEventListener('click', () => openSheet(raceDialog));
  dlgSameTrack.addEventListener('click', () => { closeOverlay(); h.onChooseSameTrack(); });
  dlgNewTrack.addEventListener('click', () => { closeOverlay(); h.onNewTrack(); });
  overlay.querySelector('.overlay__backdrop')!.addEventListener('click', closeOverlay);
  overlay.querySelectorAll('[data-close]').forEach((b) =>
    b.addEventListener('click', closeOverlay),
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlay();
  });
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
  addLine(target, strings.race.speed(p.vel.x, p.vel.y));
  addLine(target, strings.race.crashes(p.crashes.length));
  if (p.skipTurns > 0) addLine(target, strings.race.pit(p.skipTurns));
}

/**
 * Пересобрать карточки игроков как прямых потомков #raceButtons (перед кнопкой
 * «Новая гонка») — так они попадают в двухколоночную мобильную сетку панели.
 */
function renderPlayerCards(game: GameState): void {
  raceButtons.querySelectorAll('.player-card').forEach((c) => c.remove());
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    playerInfo(p, game.phase === 'race' && game.current === i, card);
    raceButtons.insertBefore(card, newRaceBtn);
  });
}

/** Заметный шаг мастера: бейдж «Шаг N из M» + инструкция. */
function renderStepStatus(badge: string, body: string): void {
  statusEl.className = 'status status--step';
  statusEl.replaceChildren(div('status__badge', badge), div('status__body', body));
}

/** Отрисовка сообщения редактора: заметный «Шаг N из 5» + инструкция. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  const m = editor.message.match(/^(Шаг \d+ из \d+)\.\s*(.*)$/s);
  if (m) {
    renderStepStatus(m[1], m[2]);
  } else {
    statusEl.classList.add('status--step');
    statusEl.replaceChildren(div('status__body', editor.message));
  }
}

function showWinner(game: GameState): void {
  if (game.winner === 'draw') {
    winnerWho.textContent = strings.race.draw;
  } else {
    const w = game.players[game.winner!];
    const name = document.createElement('span');
    name.style.color = w.color;
    name.textContent = w.name;
    winnerWho.replaceChildren(strings.race.winnerFlag, document.createElement('br'), name);
  }
  winnerBanner.classList.add('winner--shown');
}

export function updatePanel(
  mode: PanelMode,
  editor: EditorState,
  game: GameState | null,
  playersMax = 6,
): void {
  editButtons.hidden = mode !== 'edit';
  playersButtons.hidden = mode !== 'players';
  raceButtons.hidden = mode !== 'race';

  if (mode === 'edit') {
    renderEditStatus(editor);
    backBtn.disabled = !canStepBack(editor);
    nextBtn.hidden = editor.phase !== 'adjust';
    return;
  }

  if (mode === 'players') {
    renderStepStatus(strings.players.promptBadge, strings.players.prompt);
    playerCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
      btn.disabled = Number(btn.dataset.count) > playersMax;
    });
    return;
  }

  statusEl.className = 'status';
  if (!game) return;

  renderPlayerCards(game);

  if (game.phase === 'over') {
    showWinner(game);
    statusEl.textContent = '';
    return;
  }

  winnerBanner.classList.remove('winner--shown');
  const cur = game.players[game.current];
  const warn = game.finalTurnsLeft !== null ? strings.race.finalWarn : '';
  const hint = coarsePointer ? strings.race.hintTouch : strings.race.hintMouse;
  statusEl.textContent = `${strings.race.driver(cur.name)} ${hint}${warn}`;
}
