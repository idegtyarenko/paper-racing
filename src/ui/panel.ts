// Боковая панель: владеет её DOM-элементами и обновляет их по состоянию игры.
// Диалоги (имя/код/тост) и экран лобби живут в соседних модулях; bindButtons —
// единая точка навешивания обработчиков, композирует их проводку.

import { KMH_PER_CELL } from '../config';
import { PanelMode } from '../app-state';
import { EditorState, canStepBack } from '../model/editor';
import { GameState, Player, MIN_PLAYERS } from '../model/game';
import { Difficulty } from '../model/ai';
import { msToClock } from './format';
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
const raceCodeBtn = document.getElementById('raceCode') as HTMLButtonElement;
const rulesSheet = document.getElementById('rulesSheet')!;
const raceDialog = document.getElementById('raceDialog')!;
const dlgSameTrack = document.getElementById('dlgSameTrack') as HTMLButtonElement;
const dlgSameTrackNewMode = document.getElementById(
  'dlgSameTrackNewMode',
) as HTMLButtonElement;
const dlgNewTrack = document.getElementById('dlgNewTrack') as HTMLButtonElement;
const winnerBanner = document.querySelector('.winner')!;
const winnerWho = winnerBanner.querySelector('.winner__title') as HTMLElement;

// Экран состава хотсита: ряды «Люди», «Боты», «Сложность» (последний виден при
// ботах ≥ 1) и кнопка старта.
const humanCount = document.getElementById('humanCount')!;
const playersBotCount = document.getElementById('playersBotCount')!;
const playersDifficulty = document.getElementById('playersDifficulty')!;
const playersStartBtn = document.getElementById('playersStart') as HTMLButtonElement;

// Онлайн-режим: кнопки выбора режима (лобби и диалоги — в соседних модулях).
const modeLocalBtn = document.getElementById('modeLocal') as HTMLButtonElement;
const modeOnlineBtn = document.getElementById('modeOnline') as HTMLButtonElement;
const modeBackBtn = document.getElementById('modeBack') as HTMLButtonElement;
const joinByCodeBtn = document.getElementById('joinByCode') as HTMLButtonElement;

// Режим «С компьютером»: кнопка режима, ряды «Боты» (1–5) и «Сложность», старт.
const modeAiBtn = document.getElementById('modeAI') as HTMLButtonElement;
const aiBotCount = document.getElementById('aiBotCount')!;
const aiDifficulty = document.getElementById('aiDifficulty')!;
const aiStartBtn = document.getElementById('aiStart') as HTMLButtonElement;
const aiSettingsBtn = document.getElementById('aiSettingsBtn') as HTMLButtonElement;
const aiBackBtn = document.getElementById('aiBack') as HTMLButtonElement;

// ── Состояние экранов состава (люди/боты/сложность) ───────────────────────────────
// Локальная гонка собирается на экранах «На одном устройстве» (хотсит) и «С
// компьютером» (сингл, человек всегда один). Число мест на решётке (capacity)
// приходит в updatePanel и ограничивает выбор; пере-рендер по каждому тапу.
let setupHumans = 2;
let setupBots = 0;
let aiBots = 1;
let setupDifficulty: Difficulty = 'medium';
let seatCapacity = 6;

/** Подсветить выбранную кнопку в ряду (по значению data-атрибута). */
function markSelected(container: HTMLElement, attr: string, value: string): void {
  container.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.classList.toggle('count-btn--selected', btn.dataset[attr] === value);
  });
}

export interface PanelHandlers {
  /** Шаг назад в редакторе трассы. */
  onBack: () => void;
  /** Подтвердить кромки (фаза adjust) и перейти к старт/финишу. */
  onNext: () => void;
  onConfirmMove: () => void;
  /** «Рематч» — повтор того же состава на той же трассе одним тапом (без мастера
   *  выбора режима). Локально — сохранённый состав; в онлайне (хост) — переигровка
   *  той же комнаты. Видна только когда доступен рематч (canRematch). */
  onChooseSameTrack: () => void;
  /** «Та же трасса, другой режим» — сохранить трассу, но заново пройти выбор
   *  режима/игроков, минуя рисование. */
  onSameTrackNewMode: () => void;
  /** Доступен ли рематч одним тапом (локальный состав или онлайн-хост на итогах). */
  canRematch: () => boolean;
  /** Идёт ли онлайн-сессия сейчас (диалог итогов подстраивает набор кнопок). */
  isOnline: () => boolean;
  onNewTrack: () => void;
  /** Назад из шага выбора игроков. */
  onPlayersBack: () => void;
  /** Старт локальной гонки: humans людей + bots ботов заданной сложности (боты
   *  садятся в замыкающие места). Общий обработчик хотсита и «С компьютером». */
  onStartLocal: (humans: number, bots: number, difficulty: Difficulty) => void;
  /** Открыть настройки правил заезда (кнопка ⚙ на экране состава). */
  onOpenSettings: () => void;
  /** Открыть настройки правил из лобби (кнопка ⚙, только хост). */
  onLobbySettings: () => void;
  /** Шаг выбора режима: локальная игра. */
  onModeLocal: () => void;
  /** Шаг выбора режима: онлайн (открыть диалог имени → создать игру). */
  onModeOnline: () => void;
  /** Шаг выбора режима: с компьютером (перейти к настройке числа ботов). */
  onModeAI: () => void;
  /** Назад из шага «С компьютером». */
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
  /** Хост: досадить ещё одного бота на свободное место лобби. */
  onLobbyBotAdd: () => void;
  /** Хост: убрать одного бота. */
  onLobbyBotRemove: () => void;
  /** Хост: сложность досаживаемых ботов. */
  onLobbyBotDifficulty: (d: Difficulty) => void;
  /** Выйти из лобби. */
  onLobbyLeave: () => void;
  /** Пропустить ход задержавшегося игрока (болид едет по инерции). */
  onSkip: () => void;
  /** Тап по чипу кода игры над полем — поделиться ссылкой на игру. */
  onRaceShare: () => void;
  /** Сдаться за текущего игрока (кнопка на его карточке) — он выбывает из гонки. */
  onRetire: () => void;
}

/** Состояние отправки хода в онлайне: покой / идёт запись / запись не удалась. */
export type SendState = 'idle' | 'sending' | 'failed';

// ── Кнопка подтверждения хода: единый рендер из четырёх входов ─────────────────────
// Её вид (текст/disabled/hidden) зависит от состояния отправки (setMoveSendState),
// выбора кандидата (showConfirmMove), а в онлайне ещё и от того, мой ли сейчас ход и
// сколько осталось времени (setTurnCountdown). Входы приходят из разных модулей, поэтому
// держим их в состоянии панели и собираем кнопку в одном месте — refreshConfirmBtn().
let sendState: SendState = 'idle';
let confirmSelected = false; // выбран кандидат (тач-прицеливание) — можно коммитить
let confirmAnchorTop = false; // кнопку увели в верхнюю половину поля
let confirmMyTurn = false; // онлайн: сейчас мой ход (кнопку держим видимой под таймер)
let confirmCountdownMs: number | null = null; // остаток времени на мой ход (для метки)

// Базовый (без суффикса-таймера) текст строки статуса в онлайн-гонке — его декорирует
// тикающий setTurnCountdown, чтобы не зависеть от следующего полного updatePanel и не
// накапливать суффиксы. null — не онлайн-гонка (суффикс не приписываем).
let raceStatusBase: string | null = null;

// Ждём ЧУЖОЙ онлайн-ход: статус рисуем с анимированным многоточием (см. applyWaitingStatus),
// чтобы неинтерактивная доска читалась как «ждём», а не «зависла» (m1). Только для чистого
// ожидания — не для skippable/своего хода, у которых свой UI.
let raceWaiting = false;

/**
 * Отрисовать статус ожидания чужого хода: базовый текст (с отрезанным хвостовым «…») +
 * анимированное многоточие + опциональный суффикс-таймер «· м:сс». Через DOM, а не
 * textContent, потому что многоточие анимируется CSS-псевдоэлементом; и update(), и
 * тикающий setTurnCountdown зовут этот же помощник, чтобы тик не стирал анимацию. */
function applyWaitingStatus(base: string, msLeft: number | null): void {
  const stripped = base.replace(/…$/, '');
  const dots = document.createElement('span');
  dots.className = 'waiting-dots';
  const nodes: (Node | string)[] = [stripped, dots];
  if (msLeft !== null) nodes.push(` · ${msToClock(msLeft)}`);
  statusEl.replaceChildren(...nodes);
}

/** Настроен ли онлайн-бэкенд: без него «Войти по коду» прячем всегда. */
let onlineEnabled = false;

/** Собрать вид кнопки подтверждения из текущего состояния панели. */
function refreshConfirmBtn(): void {
  const timer = confirmCountdownMs !== null ? msToClock(confirmCountdownMs) : null;
  // Кнопка-таймер: мой ход, но цель ещё не выбрана — некликабельная заглушка с отсчётом.
  const timerOnly =
    confirmMyTurn && !confirmSelected && sendState !== 'failed' && !!timer;
  confirmMoveBtn.classList.toggle('confirm-move--top', confirmAnchorTop);
  // Только-таймер — не кликается и пропускает клики к полю (иначе накрыла бы кандидата).
  confirmMoveBtn.classList.toggle('confirm-move--timer', timerOnly);
  // Видима, если есть что подтверждать / идёт отправка (или ошибка) / это мой онлайн-ход.
  confirmMoveBtn.hidden = !(confirmSelected || sendState !== 'idle' || confirmMyTurn);
  confirmMoveBtn.disabled = sendState === 'sending' || timerOnly;
  confirmMoveBtn.textContent =
    sendState === 'sending'
      ? strings.online.sending
      : sendState === 'failed'
        ? strings.online.retrySend
        : timerOnly
          ? `⏱ ${timer}`
          : confirmSelected && timer
            ? `${strings.buttons.confirmMove} · ${timer}`
            : strings.buttons.confirmMove;
}

/**
 * Отразить состояние отправки хода на кнопке подтверждения: «Отправка…» (заблокирована,
 * чтобы не слать дубли) / «↻ Отправить ещё раз» после ошибки / обычное «Едем!». Пока
 * идёт запись или после ошибки кнопка видима и на десктопе (где обычно скрыта), чтобы
 * игрок видел прогресс и мог повторить. */
export function setMoveSendState(s: SendState): void {
  sendState = s;
  refreshConfirmBtn();
}

/** Показать/спрятать плавающую кнопку подтверждения хода (тач-прицеливание).
 *  Во время отправки / после ошибки кнопку не прячем — на ней прогресс/повтор.
 *  `anchor` уводит кнопку в свободную от кандидатов половину поля, чтобы она не
 *  накрывала точки-цели (иначе тап по цели попадёт в кнопку). */
export function showConfirmMove(
  show: boolean,
  anchor: 'top' | 'bottom' = 'bottom',
): void {
  confirmSelected = show;
  confirmAnchorTop = anchor === 'top';
  refreshConfirmBtn();
}

/**
 * Онлайн-отсчёт времени на ход. Мой ход → таймер живёт на кнопке подтверждения (её
 * держим видимой всегда, даже до выбора цели). Чужой ход → приписываем «· м:сс» к строке
 * статуса. `null` — хода/гонки нет: снять таймер и вернуть базовый статус. Локальный
 * (не онлайн) флоу этой функции не касается — там она не зовётся. */
export function setTurnCountdown(msLeft: number | null, mine = false): void {
  confirmMyTurn = mine && msLeft !== null;
  confirmCountdownMs = mine ? msLeft : null;
  if (raceStatusBase !== null) {
    // Свой таймер — на кнопке, статус («Твой ход…») не трогаем; чужой — суффикс в статус.
    if (raceWaiting) {
      // Ждём чужой ход: DOM-статус с анимированным многоточием + опциональный таймер.
      applyWaitingStatus(raceStatusBase, !mine ? msLeft : null);
    } else {
      statusEl.textContent =
        !mine && msLeft !== null
          ? `${raceStatusBase} · ${msToClock(msLeft)}`
          : raceStatusBase;
    }
  }
  refreshConfirmBtn();
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
  // Экран состава (хотсит): люди / боты / сложность — тап меняет выбор и пере-рендерит.
  humanCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      setupHumans = Number(btn.dataset.humans);
      renderPlayersSetup();
    });
  });
  playersBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      setupBots = Number(btn.dataset.bots);
      renderPlayersSetup();
    });
  });
  playersDifficulty
    .querySelectorAll<HTMLButtonElement>('[data-difficulty]')
    .forEach((btn) => {
      bindTap(btn, () => {
        setupDifficulty = btn.dataset.difficulty as Difficulty;
        renderPlayersSetup();
      });
    });
  bindTap(playersStartBtn, () => h.onStartLocal(setupHumans, setupBots, setupDifficulty));
  bindTap(settingsBtn, h.onOpenSettings);
  bindTap(modeLocalBtn, h.onModeLocal);
  bindTap(modeOnlineBtn, h.onModeOnline);
  bindTap(modeAiBtn, h.onModeAI);
  // Экран «С компьютером» (сингл, человек всегда один): число ботов + их сложность.
  aiBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    bindTap(btn, () => {
      aiBots = Number(btn.dataset.bots);
      renderAiSetup();
    });
  });
  aiDifficulty.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((btn) => {
    bindTap(btn, () => {
      setupDifficulty = btn.dataset.difficulty as Difficulty;
      renderAiSetup();
    });
  });
  bindTap(aiStartBtn, () => h.onStartLocal(1, aiBots, setupDifficulty));
  bindTap(aiSettingsBtn, h.onOpenSettings);
  bindTap(aiBackBtn, h.onAiBack);
  bindTap(modeBackBtn, h.onModeBack);
  bindTap(joinByCodeBtn, h.onJoinByCode);
  bindTap(skipBtn, h.onSkip);
  bindTap(raceCodeBtn, h.onRaceShare);
  // «Сдаться» — сперва диалог подтверждения, затем сама сдача.
  bindTap(retireBtn, () =>
    openConfirm(
      strings.race.retireConfirmTitle,
      strings.race.retireConfirmYes,
      h.onRetire,
    ),
  );
  bindTap(helpBtn, () => openSheet(rulesSheet));
  bindTap(newRaceBtn, () => {
    // «Рематч» показываем только когда есть что повторить: локальный состав или,
    // в онлайне, хост на экране итогов (canRematch покрывает оба).
    dlgSameTrack.hidden = !h.canRematch();
    // «Та же трасса, другой режим» ведёт в локальный мастер (goToMode) — в живой
    // онлайн-сессии это рассинхронизировало бы игру, поэтому онлайн её прячем.
    // Остаётся «Рематч» (хост) и «Начертить новую» (для онлайна = выход из сессии).
    dlgSameTrackNewMode.hidden = h.isOnline();
    openSheet(raceDialog);
  });
  bindTap(dlgSameTrack, () => {
    closeOverlay();
    h.onChooseSameTrack();
  });
  bindTap(dlgSameTrackNewMode, () => {
    closeOverlay();
    h.onSameTrackNewMode();
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
  /** Код текущей онлайн-игры (для чипа над полем — подсказать выпавшему). */
  code: string;
  /** Этот клиент — создатель трассы (может запустить рематч на экране итогов). */
  isHost: boolean;
}

/**
 * Экран состава хотсита: применить ограничения решётки к рядам «Люди»/«Боты»,
 * подсветить выбор, показать ряд сложности при ботах ≥ 1 и разрешить старт, когда
 * участников хотя бы MIN_PLAYERS и они влезают на стартовую решётку (seatCapacity).
 * Людей минимум MIN_PLAYERS: гонка с одним человеком — это режим «С компьютером»
 * (см. renderAiSetup), а не хотсит, поэтому ряд «Люди» начинается с 2.
 */
function renderPlayersSetup(): void {
  // Клампим выбор под вместимость: людей от MIN_PLAYERS до решётки, ботов — под остаток.
  setupHumans = Math.max(MIN_PLAYERS, Math.min(setupHumans, seatCapacity));
  setupBots = Math.max(0, Math.min(setupBots, seatCapacity - setupHumans));
  humanCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = Number(btn.dataset.humans) > seatCapacity;
  });
  playersBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = setupHumans + Number(btn.dataset.bots) > seatCapacity;
  });
  markSelected(humanCount, 'humans', String(setupHumans));
  markSelected(playersBotCount, 'bots', String(setupBots));
  playersDifficulty.hidden = setupBots === 0;
  markSelected(playersDifficulty, 'difficulty', setupDifficulty);
  const total = setupHumans + setupBots;
  playersStartBtn.disabled = total < MIN_PLAYERS || total > seatCapacity;
}

/**
 * Экран «С компьютером»: человек один, число ботов 1..(решётка−1), ряд сложности
 * всегда виден. Старт доступен, когда на решётке помещается человек и хотя бы бот.
 */
function renderAiSetup(): void {
  aiBots = Math.max(1, Math.min(aiBots, Math.max(1, seatCapacity - 1)));
  aiBotCount.querySelectorAll<HTMLButtonElement>('.count-btn').forEach((btn) => {
    btn.disabled = 1 + Number(btn.dataset.bots) > seatCapacity;
  });
  markSelected(aiBotCount, 'bots', String(aiBots));
  markSelected(aiDifficulty, 'difficulty', setupDifficulty);
  aiStartBtn.disabled = seatCapacity < MIN_PLAYERS;
}

/** Контекст перерисовки панели. Один объект вместо россыпи позиционных параметров:
 *  на месте вызова читаемо, какой флаг что значит (было `updatePanel(m, e, g, 6, net,
 *  true, true)`). Разбиение тела по экранам — за редизайном (см. INTERNAL_roadmap). */
export interface PanelCtx {
  mode: PanelMode;
  editor: EditorState;
  game: GameState | null;
  /** Максимум мест (из числа стартовых точек трассы). По умолчанию 6. */
  playersMax?: number;
  /** Онлайн-контекст текущего хода. null — локальная игра. */
  net?: NetTurn | null;
  /** Сейчас ходит бот (локально) — подсказку «нажми на точку» не показываем. */
  aiTurn?: boolean;
  /** Показать «Сдаться» в шапке (локальный игрок ещё в гонке). */
  canRetire?: boolean;
}

export function updatePanel(ctx: PanelCtx): void {
  const {
    mode,
    editor,
    game,
    playersMax = 6,
    net = null,
    aiTurn = false,
    canRetire = false,
  } = ctx;
  seatCapacity = playersMax;
  editButtons.hidden = mode !== 'edit';
  modeButtons.hidden = mode !== 'mode';
  aiButtons.hidden = mode !== 'ai';
  lobbyButtons.hidden = mode !== 'lobby';
  playersButtons.hidden = mode !== 'players';
  raceButtons.hidden = mode !== 'race';
  skipBtn.hidden = true; // покажем ниже только в гонке, когда доступен пропуск
  retireBtn.hidden = !canRetire; // «Сдаться» в шапке — пока локальный игрок в гонке

  // Чип кода игры над полем: только в идущей онлайн-гонке (net != null), чтобы можно
  // было подсказать выпавшему код/ссылку. На экране победителя и в локальной — прячем.
  const showCode = mode === 'race' && !!net && !!game && game.phase !== 'over';
  raceCodeBtn.hidden = !showCode;
  if (showCode) raceCodeBtn.textContent = `🔗 ${net!.code}`;

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
    renderAiSetup();
    return;
  }

  if (mode === 'lobby') {
    // Содержимое лобби (код, ростер, статус) рисует renderLobby().
    return;
  }

  if (mode === 'players') {
    renderStepStatus(strings.players.promptBadge, strings.players.prompt);
    renderPlayersSetup();
    return;
  }

  statusEl.className = 'status';
  raceStatusBase = null; // по умолчанию не декорируем статус таймером (задаём в ветке net)
  raceWaiting = false; // анимированное многоточие взводим только в чистом «чужой ход»
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
    // Гостю онлайн-гонки на итогах подсказываем, что рематч запускает создатель трассы
    // (сам гость кнопки рематча не имеет — его провалит в новую гонку onGameState).
    statusEl.textContent = net && !net.isHost ? strings.online.rematchWaiting : '';
    return;
  }

  if (net) {
    if (net.canSkip) {
      raceStatusBase = strings.online.skippable(net.currentName);
      statusEl.textContent = raceStatusBase;
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
    } else if (net.yourTurn) {
      // Мой ход: таймер живёт на кнопке подтверждения, статус не декорируем.
      statusEl.textContent = strings.online.yourTurn;
    } else {
      // Чужой ход: базу запоминаем — тикающий отсчёт припишет к ней «· м:сс».
      // Многоточие анимируем, чтобы неинтерактивная доска читалась как «ждём» (m1).
      raceStatusBase = strings.online.turnOf(cur.name);
      raceWaiting = true;
      applyWaitingStatus(raceStatusBase, null);
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
