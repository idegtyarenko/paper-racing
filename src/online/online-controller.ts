// Онлайн-флоу поверх online.ts: хост/вход/старт/выход/шаринг + обработчики
// realtime-событий сессии. Всё «сетевое взаимодействие с UI» вынесено из main.ts.
// Контроллер не владеет состоянием приложения (game/mode/raceTrack/editor) —
// читает и мутирует его через переданный на init OnlineDeps, а перерисовку и
// пересчёт делает его же колбэками. Ровно один контроллер на приложение.

import { Track } from '../model/track';
import {
  GameState,
  Candidate,
  newGame,
  shuffledIndices,
  cloneState,
  seatColor,
  isFinished,
} from '../model/game';
import { coastMove, applyMove, retireSeat } from '../model/turns';
import { Difficulty, chooseMove } from '../model/ai';
import { editorFromTrack } from '../model/editor';
import { renderLobby, setLobbyStarting } from '../ui/lobby';
import {
  openNameDialog,
  openJoinDialog,
  showJoinError,
  showToast,
  setJoinBusy,
  setConnBanner,
} from '../ui/dialogs';
import { closeOverlay } from '../ui/dom';
import { openConfirm } from '../ui/confirm';
import { AppState } from '../app-state';
import { NetTurn, setMoveSendState } from '../ui/panel';
import {
  TURN_TIMEOUT_MS,
  LOBBY_PRUNE_MS,
  SKIP_RETRY_MS,
  AI_MOVE_DELAY_MS,
} from '../config';
import { strings } from '../strings';
import * as session from './online';
import { OnlineHandlers } from './online';

/**
 * Мост к главному модулю: контроллер не держит состояние сам. Данные читает и
 * мутирует по ссылке через `state` (`state.game`, `state.mode`, …); отдельные
 * get/set-переходники на каждое поле больше не нужны. Остаются только колбэки-
 * поведение: `setGame` (у него побочные эффекты — гасит цикл ботов, пересобирает
 * nav) и перерисовка/сброс/таймер.
 */
export interface OnlineDeps {
  /** Единое состояние приложения (по ссылке, см. app-state.ts). */
  state: AppState;
  /** Заменить гонку: гасит локальный цикл ботов, пересобирает nav, сбрасывает рематч. */
  setGame(g: GameState): void;
  /** Вписать текущее содержимое (трассу) по центру вьюпорта. */
  fitToContent(): void;
  refreshCands(): void;
  updateUI(): void;
  /** Показать остаток времени на текущий ход (мой — на кнопке, чужой — в статусе). */
  setTurnCountdown(msLeft: number | null, mine: boolean): void;
  redraw(): void;
  /** Полный сброс к чистому редактору (выход из онлайна). */
  resetToEdit(): void;
}

let deps: OnlineDeps;

export function initOnline(d: OnlineDeps): void {
  deps = d;
  // Закрытие/уход со страницы: сразу снимаем присутствие (чтобы остальные быстрее
  // увидели офлайн и включили пропуск), а при реальном выгрузе из лобби — освобождаем
  // место. В гонке место оставляем: его двигает авто-пропуск. persisted → bfcache
  // (страница может вернуться), сессию не рвём.
  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    if (!session.active()) return;
    session.untrack();
    if (!e.persisted && deps.state.mode === 'lobby') {
      session.leave();
      forgetSession(); // место освобождено — возвращаться некуда
    }
  });
}

// ── Наблюдатель за ходом: таймаут 30 с + пропуск (инерция) ────────────────────────
// Присутствующего, но не ходящего игрока через 30 с может пропустить любой другой
// (ручная кнопка). Отсутствующего (закрыл вкладку) пропускаем автоматически: первый
// ход — с 30-секундной форой от момента ухода (шанс на реконнект), дальше — сразу.
// Авто-пропуск делает только «назначенный» присутствующий клиент (минимальный seat),
// чтобы не слать дубликаты; результат детерминирован, так что гонок записи нет.

let skipTimer: number | null = null;
let lobbyPruneTimer: number | null = null;
/** Таймер отложенного хода бота (host-only) — гасится вместе со слежением за ходом. */
let botTimer: number | null = null;
/** Отсчёт остатка времени на ход: момент начала хода (локальные часы) + тикер обновления
 *  метки. Локальный per-client отсчёт (без общего timestamp в стейте) — небольшой разброс
 *  между клиентами допустим для «мягкого» таймера. */
let turnStartAt: number | null = null;
let tickTimer: number | null = null;
/** Показывать ли кнопку ручного пропуска (истинно только для присутствующего игрока). */
let skipVisible = false;

// ── Боты в онлайне (host-local fill) ──────────────────────────────────────────────
// Хост держит число ботов и их сложность локально; при старте они материализуются в
// замыкающие свободные места (startOnline) и едут гостям в стейте (Player.bot). Гости
// ботов не ведут — ходы бота считает и коммитит только хост (см. scheduleBotMove).
// Живые игроки приоритетнее: боты не занимают серверных мест лобби, поэтому вошедший
// игрок никогда не блокируется ботом, а lobbyBots пере-клампится по свободным местам.
let lobbyBots = 0;
let lobbyBotDifficulty: Difficulty = 'medium';
/** Идёт ли запись хода бота (host-only) — защита от дублей, как skipSending. */
let botSending = false;

/** Свободные места лобби под ботов: вместимость трассы минус реальные игроки. */
function freeSeats(): number {
  const cap = deps.state.raceTrack?.startPoints.length ?? 0;
  return Math.max(0, cap - session.getRoster().length);
}

/** Место занято ботом (в идущей гонке)? Бот-ность живёт в стейте (Player.bot). */
function isBotSeat(game: GameState, seat: number): boolean {
  return !!game.players[seat]?.bot;
}

// ── Защита от дублей и confirm-first отправка ─────────────────────────────────────

/** Идёт ли сейчас сессионная операция (host/join/start/leave) — не более одной за раз,
 *  чтобы повторные тапы не плодили параллельные создания/входы. */
let busy = false;
async function guarded(fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await fn();
  } finally {
    busy = false;
  }
}

/** Идёт ли отправка хода и какой кандидат ждёт (для повтора после ошибки). */
let sending = false;
let pendingCand: Candidate | null = null;
/** Идёт ли запись пропуска (авто/ручного) — защита от дублей. */
let skipSending = false;

/** Результат confirm-first: применили копию у себя (`applied`) или за время записи
 *  прилетел авторитетный чужой стейт и локальное применение пропущено (`superseded`). */
type PushResult = 'applied' | 'superseded';

/**
 * Общее ядро всех «confirm-first» операций (ход/сдача/пропуск/ход бота): применяем
 * mutate к КОПИИ base, пишем на сервер и лишь при успехе (и если за время записи не
 * прилетел авторитетный чужой стейт) делаем копию текущим стейтом. Оригинал не
 * трогаем — при ошибке выбор/кандидаты целы. Ошибку записи ПРОБРАСЫВАЕМ: ветка
 * ошибки у каждого вызывающего своя (флаги, тост, повтор). Перерисовку (commitOnline)
 * и сброс флагов делает вызывающий по результату — так сохраняется точный порядок
 * (сброс send-state до перерисовки; clearTurnWatch до перерисовки у пропуска/бота).
 */
async function confirmFirst(
  base: GameState,
  mutate: (next: GameState) => void,
): Promise<PushResult> {
  const next = cloneState(base);
  mutate(next);
  await session.pushMove(next);
  if (deps.state.game !== base) return 'superseded'; // эхо/чужой ход уже применился
  deps.setGame(next);
  return 'applied';
}

/**
 * Отправить свой ход (confirm-first): применяем к копии, пишем на сервер и лишь при
 * успехе делаем копию текущим стейтом. Оригинал не трогаем — при ошибке выбор игрока
 * и кандидаты целы, кнопка превращается в «↻ Отправить ещё раз». Identity-guard: если
 * пока шла запись прилетел авторитетный стейт (эхо/чужой ход), локальное применение
 * пропускаем.
 */
export async function sendMove(cand: Candidate): Promise<void> {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || sending) return;
  if (session.mySeat() !== game.current) return; // уже не мой ход
  sending = true;
  pendingCand = cand;
  setMoveSendState('sending');
  try {
    const r = await confirmFirst(game, (next) => applyMove(next, cand));
    sending = false;
    pendingCand = null;
    setMoveSendState('idle');
    if (r === 'applied') commitOnline();
  } catch {
    sending = false;
    if (deps.state.game !== game) {
      pendingCand = null;
      setMoveSendState('idle');
      return;
    }
    setMoveSendState('failed');
    deps.updateUI(); // статус → «не получилось отправить…»
  }
}

/** Повторить последнюю неудавшуюся отправку хода (десктоп: выделения нет — берём pendingCand). */
export function retryMove(): void {
  if (pendingCand) sendMove(pendingCand);
}

/**
 * Сдаться (confirm-first): игрок выбывает из гонки. Применяем retireSeat своего
 * места к копии, пишем на сервер и лишь при успехе делаем её текущим стейтом.
 * Сдаться можно в любой момент, не обязательно в свой ход (retireSeat не двигает
 * очередь, если сдался не ходящий сейчас). При ошибке — тост и сброс состояния
 * (повтора нет: сдача не критична, игрок может нажать снова).
 */
export async function sendRetire(): Promise<void> {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || sending) return;
  const seat = session.mySeat();
  const me = game.players[seat];
  if (!me || isFinished(me) || me.retired) return; // уже финишировал/сошёл
  sending = true;
  setMoveSendState('sending');
  try {
    const r = await confirmFirst(game, (next) => retireSeat(next, seat));
    sending = false;
    setMoveSendState('idle');
    if (r === 'applied') commitOnline();
  } catch {
    sending = false;
    setMoveSendState('idle');
    showToast(strings.online.error);
  }
}

function clearTurnWatch(): void {
  if (skipTimer !== null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  if (botTimer !== null) {
    clearTimeout(botTimer);
    botTimer = null;
  }
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  turnStartAt = null;
  deps.setTurnCountdown(null, false); // снять таймер — иначе завис бы «· 0:00»
  skipVisible = false;
}

/** Снять все таймеры слежения (выход из сессии/закрытие игры). */
function clearWatches(): void {
  clearTurnWatch();
  if (lobbyPruneTimer !== null) {
    clearTimeout(lobbyPruneTimer);
    lobbyPruneTimer = null;
  }
}

/**
 * Убрать из лобби места, чьи вкладки офлайн дольше LOBBY_PRUNE_MS (фора на реколнект).
 * Прунит только назначенный присутствующий клиент. Если есть места, чья фора ещё не
 * вышла, перепланируем проверку на ближайший дедлайн (без нового presence-события).
 */
function pruneAbsentLobby(): void {
  if (lobbyPruneTimer !== null) {
    clearTimeout(lobbyPruneTimer);
    lobbyPruneTimer = null;
  }
  if (session.designatedSkipper() !== session.mySeat()) return;
  let soonest = Infinity;
  session.getRoster().forEach((_, seat) => {
    const left = session.leftAtOf(seat);
    if (left === null) return;
    const waited = Date.now() - left;
    if (waited >= LOBBY_PRUNE_MS) session.prune(seat).catch(() => {});
    else soonest = Math.min(soonest, LOBBY_PRUNE_MS - waited);
  });
  if (soonest !== Infinity) {
    lobbyPruneTimer = window.setTimeout(() => {
      if (deps.state.mode === 'lobby') pruneAbsentLobby();
    }, soonest);
  }
}

/**
 * Активен ли на этом стейте локальный игрок: ещё в гонке — не сдался и не
 * финишировал. Только такие игроки вправе пропускать чужие ходы.
 */
function iAmActive(game: GameState): boolean {
  const me = game.players[session.mySeat()];
  return !!me && !isFinished(me) && !me.retired;
}

/** Пересчитать слежение за текущим ходом. Зовётся на каждый стейт и presence-событие. */
function armTurnWatch(): void {
  clearTurnWatch();
  const game = deps.state.game;
  if (!session.active() || !game || game.phase !== 'race') return;
  const cur = game.current;

  // Ход бота считает и коммитит только хост; гости просто ждут его pushMove как
  // обычный чужой ход. Бот-место никогда не «present» (иначе его авто-пропустил бы
  // designatedSkipper) и не тикает таймером — боты по времени не лимитируются.
  if (isBotSeat(game, cur)) {
    if (session.isHost()) scheduleBotMove(cur);
    return;
  }

  // Лимит на ход — из правил заезда (задаёт хост в настройках); старые стейты без
  // поля подстрахованы дефолтом.
  const limit = game.rules.turnLimitMs ?? TURN_TIMEOUT_MS;

  // Локальный отсчёт остатка времени — для меня (метка на кнопке) и для соперников
  // (суффикс в статусе). Стартуем до early-return «мой ход», чтобы был виден и мне.
  turnStartAt = Date.now();
  const tick = (): void => {
    const g = deps.state.game;
    if (!session.active() || !g || g.phase !== 'race' || turnStartAt === null) return;
    const msLeft = Math.max(0, limit - (Date.now() - turnStartAt));
    deps.setTurnCountdown(msLeft, g.current === session.mySeat());
  };
  tick();
  tickTimer = window.setInterval(tick, 500);

  if (cur === session.mySeat()) return; // мой ход — за собой не слежу (пропуск не нужен)

  if (session.isPresent(cur)) {
    // Онлайн, но задумался — по истечении лимита открываем ручной пропуск остальным.
    // Пропускать чужой ход может лишь активный игрок (не сдавшийся и не
    // финишировавший) — выбывшие в гонке уже не участвуют.
    if (!iAmActive(game)) return;
    skipTimer = window.setTimeout(() => {
      skipVisible = true;
      deps.updateUI();
    }, limit);
    return;
  }
  // Отсутствует: авто-пропуск выполняет назначенный присутствующий клиент.
  if (session.designatedSkipper() !== session.mySeat()) return;
  const left = session.leftAtOf(cur);
  const grace = left === null ? limit : Math.max(0, limit - (Date.now() - left));
  skipTimer = window.setTimeout(() => autoSkip(cur), grace);
}

/**
 * Онлайн-аналог локального commit(): пересчёт кандидатов → панель → канвас →
 * перевзвод слежения за ходом (armTurnWatch). Звать после того, как setGame сделал
 * свой/входящий стейт текущим. Отличается от main.commit тем, что вместо
 * scheduleAiMove завершается armTurnWatch (онлайн-специфика: таймер хода, авто-пропуск,
 * ход бота у хоста). onGameState не использует — там особый порядок (armTurnWatch до
 * updateUI, чтобы skipVisible сбросился под новый ход).
 */
function commitOnline(): void {
  deps.refreshCands();
  deps.updateUI();
  deps.redraw();
  armTurnWatch();
}

/** Авто-пропуск отсутствующего игрока (если он всё ещё офлайн и ходит сейчас). */
function autoSkip(seat: number): void {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || game.current !== seat) return;
  if (session.isPresent(seat)) return; // вернулся — ждём его самого
  if (session.designatedSkipper() !== session.mySeat()) return;
  applySkip(game);
}

/**
 * Применить пропуск (confirm-first): болид едет по инерции в копии, пишем на сервер и
 * лишь при успехе делаем её текущим стейтом. При ошибке локально ничего не меняем.
 * Авто-пропуск — тихо перепланируем повтор через SKIP_RETRY_MS (autoSkip сам
 * перепроверит условия); ручной — оставляем кнопку на месте, чтобы можно было нажать снова.
 */
async function applySkip(game: GameState): Promise<void> {
  if (skipSending) return;
  skipSending = true;
  try {
    const r = await confirmFirst(game, (next) => coastMove(next));
    if (r === 'applied') {
      clearTurnWatch(); // сбросить skipVisible/countdown до перерисовки панели
      commitOnline();
    }
  } catch {
    showToast(strings.online.error);
    // Авто-пропуск: тихий повтор — autoSkip перепроверит (тот же ход, игрок офлайн, я
    // назначенный). Ручной пропуск: skipVisible остаётся true, кнопка доступна снова.
    if (!session.isPresent(game.current)) {
      skipTimer = window.setTimeout(() => autoSkip(game.current), SKIP_RETRY_MS);
    }
  } finally {
    skipSending = false;
  }
}

/**
 * Запланировать ход бота (host-only): пауза AI_MOVE_DELAY_MS, чтобы человек успел
 * следить за ходом бота, как в локальной игре. Один таймер за раз (clearTurnWatch
 * гасит его на каждом ре-планировании слежения).
 */
function scheduleBotMove(seat: number): void {
  if (botTimer !== null) return;
  botTimer = window.setTimeout(() => {
    botTimer = null;
    runBotMove(seat);
  }, AI_MOVE_DELAY_MS);
}

/**
 * Посчитать и закоммитить ход бота (host-only, confirm-first): применяем ход бота к
 * копии стейта, пишем на сервер и лишь при успехе делаем её текущей — гости получат
 * ход как обычный чужой (echo-guard, как в applySkip). Нет хода/нет nav → пас по
 * инерции. Ошибка — тихий повтор через SKIP_RETRY_MS. botSending защищает от
 * параллельных записей, пока запущенная ждёт сервер.
 */
async function runBotMove(seat: number): Promise<void> {
  if (botSending) return;
  const game = deps.state.game;
  if (
    !game ||
    game.phase !== 'race' ||
    game.current !== seat ||
    !isBotSeat(game, seat) ||
    !session.isHost()
  )
    return;
  botSending = true;
  const nav = deps.state.raceNav;
  try {
    const r = await confirmFirst(game, (next) => {
      // Нет хода/нет nav → пас по инерции. cand считаем на копии внутри mutate.
      const cand = nav ? chooseMove(next, nav, game.players[seat].bot!) : null;
      if (cand) applyMove(next, cand);
      else coastMove(next);
    });
    if (r === 'applied') {
      clearTurnWatch(); // сбросить skipVisible/countdown до перерисовки панели
      commitOnline();
    }
  } catch {
    showToast(strings.online.error);
    // Тихий повтор: ход всё ещё за ботом и мы всё ещё хост — runBotMove перепроверит.
    botTimer = window.setTimeout(() => {
      botTimer = null;
      runBotMove(seat);
    }, SKIP_RETRY_MS);
  } finally {
    botSending = false;
  }
}

/** Онлайн-контекст текущего хода для панели: чей ход, мой ли, можно ли пропустить,
 *  кто сейчас офлайн. Null — если не в онлайн-игре. */
export function netTurn(game: GameState | null): NetTurn | null {
  if (!session.active() || !game) return null;
  return {
    yourTurn: session.mySeat() === game.current,
    canSkip: skipVisible,
    currentName: game.players[game.current]?.name ?? '',
    // Бот-места всегда «в сети» (их ведёт хост) — не помечаем их офлайном.
    present: game.players.map((p, i) => !!p.bot || session.isPresent(i)),
    code: session.getCode() ?? '',
    isHost: session.isHost(),
  };
}

/** Кнопка «Пропустить ход» (доступна, когда истёк таймаут присутствующего игрока). */
export function skip(): void {
  const game = deps.state.game;
  if (!game || game.phase !== 'race' || !skipVisible) return;
  if (game.current === session.mySeat()) return;
  if (!iAmActive(game)) return; // выбывший игрок чужой ход не пропускает
  applySkip(game);
}

function savedName(): string {
  try {
    return localStorage.getItem('pr-player-name') ?? '';
  } catch {
    // localStorage недоступен (приватный режим) — имени просто нет.
    return '';
  }
}
function rememberName(n: string): void {
  try {
    localStorage.setItem('pr-player-name', n);
  } catch {
    // недоступен — не запоминаем, ничего страшного.
  }
}

// ── «Хлебная крошка» последней онлайн-сессии ─────────────────────────────────────
// Код активной игры в localStorage: после дисконнекта/перезагрузки (когда in-memory
// код в online.ts потерян) даёт при запуске предложить вернуться в игру.
const SESSION_KEY = 'pr-online-session';
function rememberSession(code: string): void {
  try {
    // Зовётся на каждый applyRow (в т.ч. каждый ход) — не пишем, если уже актуально.
    if (localStorage.getItem(SESSION_KEY) !== code)
      localStorage.setItem(SESSION_KEY, code);
  } catch {
    // localStorage недоступен — просто не запоминаем.
  }
}
function savedSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}
function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // недоступен — ничего страшного.
  }
}

/** Разложить ошибку присоединения в понятный текст. */
function joinErrorText(e: unknown): string {
  const m = (e as { message?: string })?.message ?? '';
  if (m.includes('game_not_found')) return strings.online.notFound;
  if (m.includes('game_full')) return strings.online.full;
  if (m.includes('game_started')) return strings.online.started;
  return strings.online.error;
}

/** Перерисовать панель лобби по текущему ростеру сессии. */
function renderLobbyPanel(): void {
  const roster = session.getRoster();
  const mine = session.mySeat();
  const maxBots = freeSeats();
  // Живые игроки приоритетнее ботов: если вошёл новый игрок, свободных мест стало
  // меньше — ужимаем число ботов под них (при выходе игрока максимум снова вырастет,
  // но текущее число не восстанавливаем — только верхнюю границу).
  if (lobbyBots > maxBots) lobbyBots = maxBots;
  renderLobby({
    code: session.getCode() ?? '',
    players: roster.map((r, i) => ({
      name: r.name,
      color: seatColor(i),
      you: i === mine,
      offline: !session.isPresent(i),
    })),
    canStart: session.canStart(),
    isHost: session.isHost(),
    botCount: lobbyBots,
    maxBots,
    botDifficulty: lobbyBotDifficulty,
  });
}

/** Хост: досадить ещё одного бота на свободное место лобби (в пределах вместимости). */
export function addBot(): void {
  if (!session.isHost() || lobbyBots >= freeSeats()) return;
  lobbyBots++;
  renderLobbyPanel();
}

/** Хост: убрать одного бота. */
export function removeBot(): void {
  if (!session.isHost() || lobbyBots <= 0) return;
  lobbyBots--;
  renderLobbyPanel();
}

/** Хост: сменить сложность досаживаемых ботов. */
export function setBotDifficulty(d: Difficulty): void {
  if (!session.isHost()) return;
  lobbyBotDifficulty = d;
  renderLobbyPanel();
}

const handlers: OnlineHandlers = {
  onLobby: () => {
    // Мы в живом лобби — запомним код для возврата после дисконнекта (идемпотентно).
    rememberSession(session.getCode()!);
    if (deps.state.mode === 'lobby') renderLobbyPanel();
  },
  onGameState: (g) => {
    // Входящий авторитетный стейт перекрывает наш незавершённый/провалившийся ход:
    // сбрасываем pending-состояние (поздний resolve нашей отправки станет инертным
    // благодаря identity-guard в sendMove, а в БД действует last-write-wins).
    pendingCand = null;
    setMoveSendState('idle');
    // Крошка для возврата после дисконнекта: держим её на идущую гонку, стираем на
    // доигранную (возвращаться на экран победителя незачем). Это единственный владелец
    // «запомнить/забыть» по авторитетному стейту — вызывается на каждый applyRow.
    if (g.phase === 'over') forgetSession();
    else rememberSession(session.getCode()!);
    // Рематч: свежая гонка прилетела поверх экрана итогов. Хост режим race не покидал,
    // поэтому обычный переход ниже (mode !== 'race') не сработает — ловим over→race
    // отдельно, чтобы закрыть диалог/баннер победителя и заново вписать поле.
    const wasOver = deps.state.game?.phase === 'over';
    deps.setGame(g);
    if (deps.state.mode !== 'race') {
      deps.state.mode = 'race';
      closeOverlay();
      deps.fitToContent();
    } else if (wasOver && g.phase === 'race') {
      closeOverlay();
      deps.fitToContent();
    }
    deps.refreshCands();
    // armTurnWatch до updateUI: он сбрасывает skipVisible под новый ход, иначе в
    // рендер утёк бы «висящий» флаг пропуска с прошлого хода (кнопка «долго не ходит»
    // на своём же ходу).
    armTurnWatch();
    deps.updateUI();
    deps.redraw();
  },
  onClosed: () => {
    clearWatches();
    forgetSession(); // игра удалена/закрыта хостом — возвращаться некуда
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    setLobbyStarting(false);
    showToast(strings.online.closed);
    deps.resetToEdit();
  },
  onConnection: (ok) => {
    setConnBanner(!ok);
    deps.updateUI();
  },
  onPresence: () => {
    // Присутствие влияет на «ждать/пропускать» и на метки офлайна в панели/лобби;
    // в лобби ещё и вычищаем брошенные места.
    armTurnWatch();
    if (deps.state.mode === 'lobby') {
      pruneAbsentLobby();
      renderLobbyPanel();
    }
    deps.updateUI();
  },
};

/** Создать онлайн-игру (хост) с введённым именем и открыть лобби. */
function hostOnline(name: string): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack) return;
    lobbyBots = 0; // свежее лобби — без досаженных ботов
    try {
      await session.host(raceTrack, name, handlers);
      deps.state.mode = 'lobby';
      deps.updateUI();
      renderLobbyPanel();
      deps.redraw();
    } catch {
      showToast(strings.online.error);
    }
  });
}

/**
 * Присоединиться к онлайн-игре по коду. inJoinDialog — ошибку показываем прямо в
 * диалоге входа (он остаётся открыт); иначе (вход по битой ссылке-приглашению) —
 * открываем диалог входа с уже заполненным кодом и постоянным текстом ошибки, чтобы
 * было видно, что пошло не так, и можно было сразу попробовать другой код — вместо
 * тоста, который гас через пару секунд и оставлял в редакторе без объяснений.
 */
function joinOnline(code: string, name: string, inJoinDialog: boolean): Promise<void> {
  return guarded(async () => {
    if (inJoinDialog) setJoinBusy(true);
    try {
      await session.join(code, name, handlers);
      closeOverlay();
      const t = session.getTrack();
      if (t) {
        deps.state.editor = editorFromTrack(t); // превью трассы хоста в лобби
        deps.state.raceTrack = null; // гость не владеет трассой
      }
      // Реконнект в уже идущую гонку: onGameState уже перевёл в режим race —
      // не сбрасываем обратно в лобби. Иначе (игра ещё не начата) — в лобби.
      if (deps.state.mode !== 'race') deps.state.mode = 'lobby';
      deps.fitToContent(); // вписать трассу хоста по центру
      deps.redraw();
      deps.updateUI();
      if (deps.state.mode === 'lobby') renderLobbyPanel();
    } catch (e) {
      if (inJoinDialog) {
        showJoinError(joinErrorText(e));
      } else {
        openJoinDialog(name, code, (code2, name2) => {
          rememberName(name2);
          joinOnline(code2, name2, true);
        });
        showJoinError(joinErrorText(e));
      }
    } finally {
      if (inJoinDialog) setJoinBusy(false);
    }
  });
}

/**
 * Собрать стартовый стейт онлайн-гонки из текущего ростера и host-local конфигурации
 * ботов. Общий для старта из лобби (startOnline) и рематча (rematchOnline) — состав
 * тот же (те же люди + те же боты), меняется лишь случайная раздача стартовых клеток.
 * Стартовые клетки раздаём случайной перестановкой среди всех участников. Это делает
 * только хост, результат уезжает в сериализованном стейте (гости players не
 * пересобирают), поэтому одинаковый сид у клиентов не нужен.
 */
function buildStartState(raceTrack: Track): GameState {
  const roster = session.getRoster();
  const humans = roster.length;
  const bots = Math.min(lobbyBots, freeSeats());
  const g = newGame(
    raceTrack,
    humans + bots,
    deps.state.rules,
    shuffledIndices(humans + bots),
  );
  roster.forEach((r, i) => {
    if (g.players[i]) g.players[i].name = r.name;
  });
  // Досадить ботов в замыкающие свободные места (после реальных игроков): их
  // бот-ность едет в стейте (Player.bot), гости получат их обычным синком, а ходы
  // считает только хост (scheduleBotMove).
  for (let i = humans; i < g.players.length; i++) {
    g.players[i].bot = lobbyBotDifficulty;
    g.players[i].name = `${strings.aiSelect.botPrefix} ${g.players[i].name}`;
  }
  return g;
}

/**
 * Хост стартует онлайн-гонку (confirm-first): строит стейт, сначала пишет его на
 * сервер и только при успехе входит в гонку. При ошибке остаёмся в лобби — «Начать
 * игру» снова активна, гости ничего не увидели (записи не было).
 */
function startOnline(): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack || !session.canStart()) return;
    const g = buildStartState(raceTrack);
    setLobbyStarting(true);
    try {
      await session.start(g);
      if (deps.state.mode !== 'race') {
        // Эхо собственной записи могло уже перевести в гонку — не дублируем.
        deps.setGame(g);
        deps.state.mode = 'race';
        deps.fitToContent();
        commitOnline();
      }
    } catch {
      showToast(strings.online.startFailed);
    } finally {
      setLobbyStarting(false);
    }
  });
}

/** Может ли этот клиент запустить рематч: он хост, гонка окончена — тогда одним тапом
 *  переигрываем на той же трассе тем же составом (кнопка «🔄 Рематч» на экране итогов). */
export function canRematch(): boolean {
  const game = deps.state.game;
  return session.isHost() && !!game && game.phase === 'over';
}

/**
 * Хост запускает рематч на той же трассе тем же составом (после онлайн-гонки).
 * Переиспользуем ту же комнату: строим свежий стейт из текущего ростера + host-local
 * ботов и пишем его в существующую строку игры (status over→race). Все клиенты, всё
 * ещё подписанные на канал, получат его обычным onGameState и провалятся в новую
 * гонку — без нового кода, без перезахода в лобби. При ошибке остаёмся на экране
 * итогов (записи не было — гости ничего не увидели).
 */
function rematchOnline(): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack || !canRematch()) return;
    const g = buildStartState(raceTrack);
    try {
      await session.start(g);
      // Хост не покидал режим race на финише — эхо собственной записи придёт через
      // onGameState с переходом over→race и там переведёт нас в новую гонку. Если эхо
      // задержится, подстрахуемся тем же путём, что startOnline.
      if (deps.state.game?.phase === 'over') {
        deps.setGame(g);
        closeOverlay();
        deps.fitToContent();
        commitOnline();
      }
    } catch {
      showToast(strings.online.startFailed);
    }
  });
}

/** Выйти из лобби: освободить место на сервере и вернуться (хост — к выбору режима). */
function leaveLobby(): Promise<void> {
  return guarded(async () => {
    clearWatches();
    forgetSession(); // осознанный выход — возвращаться некуда
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    setLobbyStarting(false);
    const wasHost = deps.state.raceTrack !== null;
    await session.leave();
    if (wasHost) {
      deps.state.mode = 'mode';
      deps.updateUI();
      deps.redraw();
    } else {
      deps.resetToEdit();
    }
  });
}

/** Поделиться ссылкой на игру (Web Share или копирование в буфер). */
async function shareLink(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  const url = `${location.origin}${import.meta.env.BASE_URL}?join=${code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: strings.app.title, url });
    } catch {
      // Пользователь отменил шаринг — ничего не делаем.
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      showToast(strings.online.copied);
    } catch {
      showToast(url);
    }
  }
}

/** Скопировать код игры в буфер. */
async function copyCode(): Promise<void> {
  const code = session.getCode();
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast(strings.online.codeCopied);
  } catch {
    // Буфер недоступен — код и так виден на экране.
  }
}

// ── Интенты для кнопок панели (bindButtons) и ссылки-приглашения ─────────────────

/** «Играть онлайн»: спросить имя и создать игру хостом. */
export function promptCreate(): void {
  openNameDialog(strings.online.create, savedName(), (name) => {
    rememberName(name);
    hostOnline(name);
  });
}

/** «Войти по коду»: диалог кода+имени, ошибка показывается в самом диалоге. */
export function promptJoin(): void {
  openJoinDialog(savedName(), '', (code, name) => {
    rememberName(name);
    joinOnline(code, name, true);
  });
}

/**
 * Открыта ссылка-приглашение (?join=CODE): подключиться к игре.
 * Повторный вход в уже активную игру (этот клиент уже в её ростере — например
 * после перезагрузки/реконнекта) — имя уже известно, не переспрашиваем и входим
 * сразу. Первый вход в игру — спрашиваем имя, как и раньше.
 */
export async function promptJoinByLink(code: string): Promise<void> {
  const known = await session.memberName(code);
  if (known) {
    rememberName(known);
    joinOnline(code, known, false);
    return;
  }
  openNameDialog(strings.online.joinSubmit, savedName(), (name) => {
    rememberName(name);
    joinOnline(code, name, false);
  });
}

/** Есть ли запомненная онлайн-сессия, в которую можно предложить вернуться. */
export function hasSavedSession(): boolean {
  return savedSession() !== null;
}

/**
 * Одноразовое предложение вернуться в последнюю онлайн-игру (после дисконнекта/
 * перезагрузки). Крошку «съедаем» при показе: «Нет» или недоступная игра больше не
 * мозолят глаза; при успешном входе joinOnline запишет её заново. Валидацию (жива ли
 * игра, в ростере ли мы) делаем только по «Да» — не сетевым запросом на каждый старт.
 */
export function promptResume(): void {
  const code = savedSession();
  if (!code) return;
  forgetSession();
  openConfirm(
    strings.online.resumeTitle(code),
    strings.online.resumeYes,
    async () => {
      const known = await session.memberName(code);
      if (!known) {
        showToast(strings.online.gameGone);
        return;
      }
      rememberName(known);
      joinOnline(code, known, false); // тот же путь, что и реконнект по ссылке
    },
    { danger: false },
  );
}

export function start(): void {
  startOnline();
}
export function rematch(): void {
  rematchOnline();
}
export function leave(): void {
  leaveLobby();
}
export function share(): void {
  shareLink();
}
export function copy(): void {
  copyCode();
}
