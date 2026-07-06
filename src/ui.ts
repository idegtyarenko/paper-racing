// Боковая панель: владеет её DOM-элементами и обновляет их по состоянию игры.

import { KMH_PER_CELL } from './config';
import { EditorState, canStepBack } from './editor';
import { GameState, Player } from './game';
import { len } from './geometry';
import { strings } from './strings';

const statusEl = document.querySelector('.status')!;

/** Основной указатель устройства — палец (телефон/планшет). */
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const editButtons = document.getElementById('editButtons')!;
const modeButtons = document.getElementById('modeButtons')!;
const lobbyButtons = document.getElementById('lobbyButtons')!;
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

// Онлайн-режим: кнопки выбора режима, лобби и диалоги.
const modeLocalBtn = document.getElementById('modeLocal') as HTMLButtonElement;
const modeOnlineBtn = document.getElementById('modeOnline') as HTMLButtonElement;
const modeBackBtn = document.getElementById('modeBack') as HTMLButtonElement;
const joinByCodeBtn = document.getElementById('joinByCode') as HTMLButtonElement;
const lobbyCodeBtn = document.getElementById('lobbyCode') as HTMLButtonElement;
const lobbyShareBtn = document.getElementById('lobbyShare') as HTMLButtonElement;
const lobbyRoster = document.getElementById('lobbyRoster')!;
const lobbyStartBtn = document.getElementById('lobbyStart') as HTMLButtonElement;
const lobbyLeaveBtn = document.getElementById('lobbyLeave') as HTMLButtonElement;
const nameDialog = document.getElementById('nameDialog')!;
const nameInput = document.getElementById('nameInput') as HTMLInputElement;
const nameConfirm = document.getElementById('nameConfirm') as HTMLButtonElement;
const joinDialog = document.getElementById('joinDialog')!;
const joinCodeInput = document.getElementById('joinCodeInput') as HTMLInputElement;
const joinNameInput = document.getElementById('joinNameInput') as HTMLInputElement;
const joinError = document.getElementById('joinError')!;
const joinConfirm = document.getElementById('joinConfirm') as HTMLButtonElement;
const toast = document.getElementById('toast')!;

/** Режим панели: рисование трассы, выбор режима/числа игроков, лобби, гонка. */
export type PanelMode = 'edit' | 'mode' | 'players' | 'lobby' | 'race';

export interface PanelHandlers {
  /** Шаг назад в редакторе трассы. */
  onBack: () => void;
  /** Подтвердить кромки (фаза adjust) и перейти к старт/финишу. */
  onNext: () => void;
  onConfirmMove: () => void;
  /** «Та же трасса» — перейти к повторному выбору режима. */
  onChooseSameTrack: () => void;
  onNewTrack: () => void;
  /** Назад из шага выбора игроков. */
  onPlayersBack: () => void;
  /** Выбрано число игроков — сразу стартуем гонку. */
  onPlayerCount: (n: number) => void;
  /** Шаг выбора режима: локальная игра. */
  onModeLocal: () => void;
  /** Шаг выбора режима: онлайн (открыть диалог имени → создать игру). */
  onModeOnline: () => void;
  /** Назад из шага выбора режима. */
  onModeBack: () => void;
  /** Открыть диалог входа по коду (с экрана рисования). */
  onJoinByCode: () => void;
  /** Хост стартует онлайн-гонку. */
  onLobbyStart: () => void;
  /** Поделиться ссылкой на игру. */
  onLobbyShare: () => void;
  /** Скопировать код игры. */
  onLobbyCopyCode: () => void;
  /** Выйти из лобби. */
  onLobbyLeave: () => void;
}

/** Показать/спрятать плавающую кнопку подтверждения хода (тач-прицеливание). */
export function showConfirmMove(show: boolean): void {
  confirmMoveBtn.hidden = !show;
}

/** Показать одну шторку оверлея, спрятав остальные. */
function openSheet(sheet: HTMLElement): void {
  overlay.querySelectorAll<HTMLElement>('.sheet').forEach((s) => (s.hidden = true));
  sheet.hidden = false;
  overlay.hidden = false;
}

/** Спрятать оверлей со всеми шторками. */
export function closeOverlay(): void {
  overlay.hidden = true;
}

// Колбэки подтверждения диалогов имени/кода (заполняются при открытии диалога).
let nameCb: ((name: string) => void) | null = null;
let joinCb: ((code: string, name: string) => void) | null = null;

/** Диалог ввода имени (создание игры / вход по ссылке). */
export function openNameDialog(
  confirmLabel: string,
  defaultName: string,
  onConfirm: (name: string) => void,
): void {
  nameConfirm.textContent = confirmLabel;
  nameInput.value = defaultName;
  nameCb = onConfirm;
  openSheet(nameDialog);
  setTimeout(() => nameInput.focus(), 50);
}

function submitName(): void {
  const v = nameInput.value.trim();
  if (!v) {
    nameInput.focus();
    return;
  }
  const cb = nameCb;
  closeOverlay();
  cb?.(v);
}

/** Диалог входа по коду (код + имя). Оверлей не закрывается сам — это делает вызывающий. */
export function openJoinDialog(
  defaultName: string,
  defaultCode: string,
  onConfirm: (code: string, name: string) => void,
): void {
  joinCodeInput.value = defaultCode;
  joinNameInput.value = defaultName;
  joinError.hidden = true;
  joinCb = onConfirm;
  openSheet(joinDialog);
  setTimeout(() => (defaultCode ? joinNameInput : joinCodeInput).focus(), 50);
}

function submitJoin(): void {
  const code = joinCodeInput.value.trim().toUpperCase();
  const name = joinNameInput.value.trim();
  if (!code || !name) return;
  joinError.hidden = true;
  joinCb?.(code, name);
}

/** Показать ошибку в диалоге входа (не закрывая его). */
export function showJoinError(msg: string): void {
  joinError.textContent = msg;
  joinError.hidden = false;
}

let toastTimer: number | undefined;

/** Короткое всплывающее уведомление (ссылка/код скопированы и т.п.). */
export function showToast(msg: string): void {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.hidden = true), 1800);
}

/** Спрятать онлайн-входы, если бэкенд не настроен (играем только локально). */
export function setOnlineEnabled(enabled: boolean): void {
  modeOnlineBtn.hidden = !enabled;
  joinByCodeBtn.hidden = !enabled;
}

export interface LobbyView {
  code: string;
  players: { name: string; color: string; you: boolean }[];
  canStart: boolean;
  isHost: boolean;
}

/** Отрисовать экран лобби: код, список игроков, кнопку «Начать» и статус. */
export function renderLobby(v: LobbyView): void {
  lobbyCodeBtn.textContent = v.code;
  lobbyRoster.replaceChildren(
    ...v.players.map((p) => {
      const li = document.createElement('li');
      li.className = 'lobby__player';
      const dot = document.createElement('span');
      dot.className = 'lobby__dot';
      dot.style.background = p.color;
      const name = document.createElement('span');
      name.className = 'lobby__name';
      name.textContent = p.name;
      li.append(dot, name);
      if (p.you) {
        const you = document.createElement('span');
        you.className = 'lobby__you';
        you.textContent = strings.online.you;
        li.append(you);
      }
      return li;
    }),
  );
  lobbyStartBtn.hidden = !v.isHost;
  lobbyStartBtn.disabled = !v.canStart;
  const body = v.isHost
    ? v.canStart
      ? strings.online.lobbyHost
      : strings.online.waiting
    : strings.online.lobbyGuest;
  renderStepStatus(strings.online.lobbyBadge, body);
}

/**
 * Надёжная активация кнопки на сенсорном экране. На iOS первый синтетический
 * `click` по кнопке, показанной сразу после жеста на canvas (например «Вперёд» в
 * редакторе или «Газу!» после прицела), теряется — кнопка срабатывает лишь со
 * второго тапа. Media-фикс `:hover` убрал только «залипающий» стиль, но не саму
 * потерю клика. Поэтому на coarse-указателе активируем прямо по завершению
 * касания (`pointerup` доходит с первого раза), а дублирующий `click`, если он
 * всё же придёт следом, гасим по времени. Мышь, стилус и клавиатура (Enter/Space
 * шлют `click` без касания) идут обычным путём. Прокрутка панели, начатая с
 * кнопки, отменяет касание через `pointercancel` — тогда `pointerup` не придёт.
 */
function bindTap(el: HTMLElement, handler: () => void): void {
  const disabled = () => el.matches(':disabled');
  if (!coarsePointer) {
    el.addEventListener('click', () => {
      if (!disabled()) handler();
    });
    return;
  }
  let tappedAt = -Infinity;
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || disabled()) return;
    tappedAt = e.timeStamp;
    handler();
  });
  el.addEventListener('click', (e) => {
    if (e.timeStamp - tappedAt < 700 || disabled()) return;
    handler();
  });
}

export function bindButtons(h: PanelHandlers): void {
  bindTap(backBtn, h.onBack);
  bindTap(nextBtn, h.onNext);
  bindTap(playersBackBtn, h.onPlayersBack);
  bindTap(confirmMoveBtn, h.onConfirmMove);
  playerCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => h.onPlayerCount(Number(btn.dataset.count)));
  });
  bindTap(modeLocalBtn, h.onModeLocal);
  bindTap(modeOnlineBtn, h.onModeOnline);
  bindTap(modeBackBtn, h.onModeBack);
  bindTap(joinByCodeBtn, h.onJoinByCode);
  bindTap(lobbyStartBtn, h.onLobbyStart);
  bindTap(lobbyShareBtn, h.onLobbyShare);
  bindTap(lobbyCodeBtn, h.onLobbyCopyCode);
  bindTap(lobbyLeaveBtn, h.onLobbyLeave);
  bindTap(nameConfirm, submitName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitName();
  });
  bindTap(joinConfirm, submitJoin);
  joinNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitJoin();
  });
  bindTap(helpBtn, () => openSheet(rulesSheet));
  bindTap(newRaceBtn, () => openSheet(raceDialog));
  bindTap(dlgSameTrack, () => {
    closeOverlay();
    h.onChooseSameTrack();
  });
  bindTap(dlgNewTrack, () => {
    closeOverlay();
    h.onNewTrack();
  });
  overlay.querySelector('.overlay__backdrop')!.addEventListener('click', closeOverlay);
  overlay
    .querySelectorAll<HTMLElement>('[data-close]')
    .forEach((b) => bindTap(b, closeOverlay));
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

/** Иконка-стат для карточки игрока (скорость / аварии / боксы). */
function stat(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

/** Стат скорости: число + отдельная единица «км/ч», которую CSS прячет на
 *  узких карточках, чтобы освободить место под имя игрока. */
function speedStat(kmh: number): HTMLSpanElement {
  const s = stat(strings.race.speed(kmh));
  const unit = document.createElement('span');
  unit.className = 'player-card__unit';
  unit.textContent = ` ${strings.race.speedUnit}`;
  s.append(unit);
  return s;
}

/**
 * Компактная карточка в одну строку: цветная точка, имя и статы иконками —
 * скорость (одно число = длина вектора разгона), аварии и, если игрок стоит
 * «в боксах» после вылета, число пропусков.
 */
function playerInfo(p: Player, active: boolean, target: HTMLElement): void {
  target.classList.toggle('player-card--active', active);
  const dot = document.createElement('span');
  dot.className = 'player-card__dot';
  dot.style.background = p.color;
  const name = document.createElement('b');
  name.className = 'player-card__name';
  name.textContent = p.name;
  const stats = document.createElement('span');
  stats.className = 'player-card__stats';
  // Длину вектора разгона переводим в условные км/ч и округляем до десятков —
  // как деления на реальном спидометре.
  const kmh = Math.round((len(p.vel) * KMH_PER_CELL) / 10) * 10;
  stats.append(speedStat(kmh), stat(strings.race.crashes(p.crashes.length)));
  if (p.skipTurns > 0) stats.append(stat(strings.race.pit(p.skipTurns)));
  target.replaceChildren(dot, name, stats);
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

/** Отрисовка сообщения редактора: заметный бейдж «Шаг N» + инструкция. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  const m = editor.message.match(/^(Шаг \d+(?: из \d+)?)\.\s*(.*)$/s);
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
    winnerWho.replaceChildren(
      strings.race.winnerFlag,
      document.createElement('br'),
      name,
    );
  }
  winnerBanner.classList.add('winner--shown');
}

/** Онлайн-контекст текущего хода — для статуса гонки (чей ход, мой ли). */
export interface NetTurn {
  yourTurn: boolean;
}

export function updatePanel(
  mode: PanelMode,
  editor: EditorState,
  game: GameState | null,
  playersMax = 6,
  net: NetTurn | null = null,
): void {
  editButtons.hidden = mode !== 'edit';
  modeButtons.hidden = mode !== 'mode';
  lobbyButtons.hidden = mode !== 'lobby';
  playersButtons.hidden = mode !== 'players';
  raceButtons.hidden = mode !== 'race';

  if (mode === 'edit') {
    renderEditStatus(editor);
    backBtn.disabled = !canStepBack(editor);
    nextBtn.hidden = editor.phase !== 'adjust';
    return;
  }

  if (mode === 'mode') {
    renderStepStatus(strings.modeSelect.promptBadge, strings.modeSelect.prompt);
    return;
  }

  if (mode === 'lobby') {
    // Содержимое лобби (код, ростер, статус) рисует renderLobby().
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
  if (net) {
    statusEl.textContent = net.yourTurn
      ? strings.online.yourTurn
      : strings.online.turnOf(cur.name);
    return;
  }
  const warn = game.finalTurnsLeft !== null ? strings.race.finalWarn : '';
  const hint = coarsePointer ? strings.race.hintTouch : strings.race.hintMouse;
  statusEl.textContent = `${strings.race.driver(cur.name)} ${hint}${warn}`;
}
