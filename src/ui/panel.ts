// Боковая панель: владеет её DOM-элементами и обновляет их по состоянию игры.
// Диалоги (имя/код/тост) и экран лобби живут в соседних модулях; bindButtons —
// единая точка навешивания обработчиков, композирует их проводку.

import { KMH_PER_CELL } from '../config';
import { EditorState, canStepBack } from '../model/editor';
import { GameState, Player } from '../model/game';
import { Difficulty } from '../model/ai';
import { len } from '../geometry';
import { strings } from '../strings';
import { coarsePointer, bindTap, openSheet, closeOverlay, bindOverlayClose } from './dom';
import { openConfirm } from './confirm';
import { div, renderStepStatus, statusElement } from './status';
import { bindDialogs } from './dialogs';
import { bindSettings } from './settings';
import { bindLobby } from './lobby';

const statusEl = statusElement();

const editButtons = document.getElementById('editButtons')!;
const modeButtons = document.getElementById('modeButtons')!;
const aiButtons = document.getElementById('aiButtons')!;
const lobbyButtons = document.getElementById('lobbyButtons')!;
const playersButtons = document.getElementById('playersButtons')!;
const raceButtons = document.getElementById('raceButtons')!;
const backBtn = document.getElementById('backBtn') as HTMLButtonElement;
const nextBtn = document.getElementById('nextBtn') as HTMLButtonElement;
const playersBackBtn = document.getElementById('playersBack') as HTMLButtonElement;
const helpBtn = document.getElementById('helpBtn') as HTMLButtonElement;
const newRaceBtn = document.getElementById('newRace') as HTMLButtonElement;
const retireBtn = document.getElementById('retireBtn') as HTMLButtonElement;
const settingsBtn = document.getElementById('settingsBtn') as HTMLButtonElement;
const confirmMoveBtn = document.getElementById('confirmMove') as HTMLButtonElement;
const skipBtn = document.getElementById('skipTurn') as HTMLButtonElement;
const rulesSheet = document.getElementById('rulesSheet')!;
const raceDialog = document.getElementById('raceDialog')!;
const dlgSameTrack = document.getElementById('dlgSameTrack') as HTMLButtonElement;
const dlgNewTrack = document.getElementById('dlgNewTrack') as HTMLButtonElement;
const winnerBanner = document.querySelector('.winner')!;
const winnerWho = winnerBanner.querySelector('.winner__title') as HTMLElement;
const playerCount = document.getElementById('playerCount')!;

// Онлайн-режим: кнопки выбора режима (лобби и диалоги — в соседних модулях).
const modeLocalBtn = document.getElementById('modeLocal') as HTMLButtonElement;
const modeOnlineBtn = document.getElementById('modeOnline') as HTMLButtonElement;
const modeBackBtn = document.getElementById('modeBack') as HTMLButtonElement;
const joinByCodeBtn = document.getElementById('joinByCode') as HTMLButtonElement;

// Режим «С компьютером»: кнопка режима и экран выбора сложности ботов.
const modeAiBtn = document.getElementById('modeAI') as HTMLButtonElement;
const aiDifficulty = document.getElementById('aiDifficulty')!;
const aiSettingsBtn = document.getElementById('aiSettingsBtn') as HTMLButtonElement;
const aiBackBtn = document.getElementById('aiBack') as HTMLButtonElement;

/** Режим панели: рисование трассы, выбор режима/числа игроков/сложности ботов,
 *  лобби, гонка. */
export type PanelMode = 'edit' | 'mode' | 'players' | 'ai' | 'lobby' | 'race';

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
  /** Открыть настройки правил заезда (кнопка ⚙ на экране числа игроков). */
  onOpenSettings: () => void;
  /** Открыть настройки правил из лобби (кнопка ⚙, только хост). */
  onLobbySettings: () => void;
  /** Шаг выбора режима: локальная игра. */
  onModeLocal: () => void;
  /** Шаг выбора режима: онлайн (открыть диалог имени → создать игру). */
  onModeOnline: () => void;
  /** Шаг выбора режима: с компьютером (перейти к выбору сложности ботов). */
  onModeAI: () => void;
  /** Выбрана сложность ботов — сразу стартуем гонку против компьютера. */
  onAiDifficulty: (d: Difficulty) => void;
  /** Назад из шага выбора сложности ботов. */
  onAiBack: () => void;
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
  /** Пропустить ход задержавшегося игрока (болид едет по инерции). */
  onSkip: () => void;
  /** Сдаться за текущего игрока (кнопка на его карточке) — он выбывает из гонки. */
  onRetire: () => void;
}

/** Состояние отправки хода в онлайне: покой / идёт запись / запись не удалась. */
export type SendState = 'idle' | 'sending' | 'failed';
let sendState: SendState = 'idle';

/** Настроен ли онлайн-бэкенд: без него «Войти по коду» прячем всегда. */
let onlineEnabled = false;

/**
 * Отразить состояние отправки хода на кнопке подтверждения: «Отправка…» (заблокирована,
 * чтобы не слать дубли) / «↻ Отправить ещё раз» после ошибки / обычное «Едем!». Пока
 * идёт запись или после ошибки кнопка видима и на десктопе (где обычно скрыта), чтобы
 * игрок видел прогресс и мог повторить. */
export function setMoveSendState(s: SendState): void {
  sendState = s;
  confirmMoveBtn.disabled = s === 'sending';
  confirmMoveBtn.textContent =
    s === 'sending'
      ? strings.online.sending
      : s === 'failed'
        ? strings.online.retrySend
        : strings.buttons.confirmMove;
  if (s !== 'idle') confirmMoveBtn.hidden = false;
}

/** Показать/спрятать плавающую кнопку подтверждения хода (тач-прицеливание).
 *  Во время отправки / после ошибки кнопку не прячем — на ней прогресс/повтор.
 *  `anchor` уводит кнопку в свободную от кандидатов половину поля, чтобы она не
 *  накрывала точки-цели (иначе тап по цели попадёт в кнопку). */
export function showConfirmMove(
  show: boolean,
  anchor: 'top' | 'bottom' = 'bottom',
): void {
  confirmMoveBtn.classList.toggle('confirm-move--top', anchor === 'top');
  confirmMoveBtn.hidden = !(show || sendState !== 'idle');
}

/** Спрятать онлайн-входы, если бэкенд не настроен (играем только локально). */
export function setOnlineEnabled(enabled: boolean): void {
  onlineEnabled = enabled;
  modeOnlineBtn.hidden = !enabled;
  joinByCodeBtn.hidden = true; // покажем только на первом шаге редактора (см. update)
}

export function bindButtons(h: PanelHandlers): void {
  bindTap(backBtn, h.onBack);
  bindTap(nextBtn, h.onNext);
  bindTap(playersBackBtn, h.onPlayersBack);
  bindTap(confirmMoveBtn, h.onConfirmMove);
  playerCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => h.onPlayerCount(Number(btn.dataset.count)));
  });
  bindTap(settingsBtn, h.onOpenSettings);
  bindTap(modeLocalBtn, h.onModeLocal);
  bindTap(modeOnlineBtn, h.onModeOnline);
  bindTap(modeAiBtn, h.onModeAI);
  aiDifficulty.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
    bindTap(btn, () => h.onAiDifficulty(btn.dataset.difficulty as Difficulty));
  });
  bindTap(aiSettingsBtn, h.onOpenSettings);
  bindTap(aiBackBtn, h.onAiBack);
  bindTap(modeBackBtn, h.onModeBack);
  bindTap(joinByCodeBtn, h.onJoinByCode);
  bindTap(skipBtn, h.onSkip);
  // «Сдаться» — сперва диалог подтверждения, затем сама сдача.
  bindTap(retireBtn, () =>
    openConfirm(
      strings.race.retireConfirmTitle,
      strings.race.retireConfirmYes,
      h.onRetire,
    ),
  );
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
  bindDialogs();
  bindSettings();
  bindLobby(h);
  bindOverlayClose();
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
  // Выбывший из гонки (финишировал или сдался) — приглушаем карточку.
  target.classList.toggle('player-card--out', p.place !== null || p.retired);
  const dot = document.createElement('span');
  dot.className = 'player-card__dot';
  dot.style.background = p.color;
  const name = document.createElement('b');
  name.className = 'player-card__name';
  name.textContent = p.name;
  const stats = document.createElement('span');
  stats.className = 'player-card__stats';
  if (p.place !== null) {
    // Финишировал — вместо спидометра показываем занятое место.
    stats.append(stat(strings.race.place(p.place)));
  } else if (p.retired) {
    stats.append(stat(strings.race.retired));
  } else {
    // Длину вектора разгона переводим в условные км/ч и округляем до десятков —
    // как деления на реальном спидометре.
    const kmh = Math.round((len(p.vel) * KMH_PER_CELL) / 10) * 10;
    stats.append(speedStat(kmh), stat(strings.race.crashes(p.crashes.length)));
    if (p.skipTurns > 0) stats.append(stat(strings.race.pit(p.skipTurns)));
  }
  target.replaceChildren(dot, name, stats);
}

/**
 * Пересобрать карточки игроков как прямых потомков #raceButtons (перед кнопкой
 * «Новая гонка») — так они попадают в двухколоночную мобильную сетку панели.
 */
function renderPlayerCards(game: GameState, present?: boolean[]): void {
  raceButtons.querySelectorAll('.player-card').forEach((c) => c.remove());
  game.players.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'player-card';
    playerInfo(p, game.phase === 'race' && game.current === i, card);
    // В онлайне помечаем игроков, чьи вкладки сейчас офлайн.
    if (present && present[i] === false) {
      card.classList.add('player-card--offline');
      card.title = strings.online.offline;
    }
    raceButtons.insertBefore(card, newRaceBtn);
  });
}

/** Отрисовка сообщения редактора: заметный бейдж «Трасса: шаг N из 4» + инструкция. */
function renderEditStatus(editor: EditorState): void {
  statusEl.className = 'status';
  if (editor.error) {
    statusEl.classList.add('status--error');
    statusEl.textContent = editor.message;
    return;
  }
  const m = editor.message.match(/^(Трасса: шаг \d+ из \d+)\.\s*(.*)$/s);
  if (m) {
    renderStepStatus(m[1], m[2]);
  } else {
    statusEl.classList.add('status--step');
    statusEl.replaceChildren(div('status__body', editor.message));
  }
}

/** Подпись под именем победителя: гонка ещё идёт для остальных / уже завершена. */
function winnerSubtitle(over: boolean): HTMLElement {
  const s = document.createElement('span');
  s.className = 'winner__subtitle';
  s.textContent = over ? strings.race.raceOver : strings.race.stillRacing;
  return s;
}

/**
 * Показать баннер: победителя (место 1) объявляем сразу, как только он определён,
 * даже если гонка продолжается для остальных — с подписью «Гонка продолжается».
 * Ничья (делёж 1-го места) — строка draw. Особый случай «все сошли, никто не
 * финишировал» (winner === null при завершённой гонке) — строка allRetired.
 */
function showWinner(game: GameState): void {
  const over = game.phase === 'over';
  // Когда все сдались (победителя нет) — без кубка, только текст.
  winnerBanner.classList.toggle('winner--noresult', game.winner === null);
  if (game.winner === null) {
    winnerWho.textContent = strings.race.allRetired;
  } else if (game.winner === 'draw') {
    winnerWho.replaceChildren(
      document.createTextNode(strings.race.draw),
      winnerSubtitle(over),
    );
  } else {
    const w = game.players[game.winner];
    const name = document.createElement('span');
    name.style.color = w.color;
    name.textContent = w.name;
    winnerWho.replaceChildren(
      strings.race.winnerFlag,
      document.createElement('br'),
      name,
      winnerSubtitle(over),
    );
  }
  winnerBanner.classList.add('winner--shown');
}

/** Онлайн-контекст текущего хода — для статуса гонки (чей ход, мой ли, можно ли
 *  пропустить, кто сейчас офлайн по местам). */
export interface NetTurn {
  yourTurn: boolean;
  /** Показать кнопку пропуска: активный игрок онлайн, но не ходит дольше таймаута. */
  canSkip: boolean;
  /** Имя игрока, чей сейчас ход (для статуса про пропуск). */
  currentName: string;
  /** Присутствие по местам (индекс = место); false — вкладка офлайн. */
  present: boolean[];
}

export function updatePanel(
  mode: PanelMode,
  editor: EditorState,
  game: GameState | null,
  playersMax = 6,
  net: NetTurn | null = null,
  aiTurn = false,
  canRetire = false,
): void {
  editButtons.hidden = mode !== 'edit';
  modeButtons.hidden = mode !== 'mode';
  aiButtons.hidden = mode !== 'ai';
  lobbyButtons.hidden = mode !== 'lobby';
  playersButtons.hidden = mode !== 'players';
  raceButtons.hidden = mode !== 'race';
  skipBtn.hidden = true; // покажем ниже только в гонке, когда доступен пропуск
  retireBtn.hidden = !canRetire; // «Сдаться» в шапке — пока локальный игрок в гонке

  if (mode === 'edit') {
    renderEditStatus(editor);
    backBtn.disabled = !canStepBack(editor);
    // На шаге 2 «← Назад» стирает всю нарисованную трассу — называем действие честно.
    backBtn.textContent =
      editor.phase === 'adjust' ? strings.buttons.redraw : strings.buttons.back;
    nextBtn.hidden = editor.phase !== 'adjust';
    // «Войти по коду» уместна только на первом шаге; дальше по мастеру она мешает.
    joinByCodeBtn.hidden = !onlineEnabled || editor.phase !== 'center';
    return;
  }

  if (mode === 'mode') {
    renderStepStatus(strings.modeSelect.promptBadge, strings.modeSelect.prompt);
    return;
  }

  if (mode === 'ai') {
    renderStepStatus(strings.aiSelect.promptBadge, strings.aiSelect.prompt);
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

  const cur = game.players[game.current];
  renderPlayerCards(game, net?.present);

  // Победителя объявляем сразу (winner !== null), даже пока гонка идёт для
  // остальных; при полном завершении гонки показываем итоговый баннер.
  if (game.winner !== null || game.phase === 'over') {
    showWinner(game);
  } else {
    winnerBanner.classList.remove('winner--shown');
  }

  if (game.phase === 'over') {
    statusEl.textContent = '';
    return;
  }

  if (net) {
    if (net.canSkip) {
      statusEl.textContent = strings.online.skippable(net.currentName);
      const name = document.createElement('b');
      name.className = 'skip-btn__name';
      name.style.color = cur.color;
      name.textContent = cur.name;
      skipBtn.replaceChildren(
        document.createTextNode(`${strings.online.skipTurnBtn} `),
        name,
      );
      skipBtn.hidden = false;
    } else if (net.yourTurn && sendState === 'failed') {
      // Ход не ушёл на сервер — держим заметный текст ошибки, пока игрок не повторит.
      statusEl.classList.add('status--error');
      statusEl.textContent = strings.online.sendFailed;
    } else {
      statusEl.textContent = net.yourTurn
        ? strings.online.yourTurn
        : strings.online.turnOf(cur.name);
    }
    return;
  }
  const warn = game.finalTurnsLeft !== null ? strings.race.finalWarn : '';
  if (aiTurn) {
    // Ходит бот: подсказка «нажми на точку» неуместна — человек просто ждёт.
    statusEl.textContent = `${strings.race.driver(cur.name)}${warn}`;
    return;
  }
  const hint = coarsePointer ? strings.race.hintTouch : strings.race.hintMouse;
  statusEl.textContent = `${strings.race.driver(cur.name)} ${hint}${warn}`;
}
