// Наблюдатель за ходом: таймаут + пропуск (инерция) + countdown-метка, плюс прунинг
// брошенных мест лобби. Вынесено из online-controller.ts (god-модуль).
//
// Присутствующего, но не ходящего игрока через лимит хода может пропустить любой другой
// (ручная кнопка). Отсутствующего (закрыл вкладку) пропускаем автоматически: первый
// ход — с форой от момента ухода (шанс на реконнект), дальше — сразу. Авто-пропуск
// делает только «назначенный» присутствующий клиент (минимальный seat), чтобы не слать
// дубликаты; результат детерминирован, так что гонок записи нет.
//
// Не владеет состоянием приложения: читает/мутирует его через переданный на init
// OnlineDeps, а confirm-first/перерисовку делает переданными колбэками. Ход бота отдаёт
// в host-bots (бот-места не тикают таймером и не пропускаются по времени).

import { GameState, isFinished } from '../model/game';
import { coastMove } from '../model/turns';
import { showToast } from '../ui/dialogs';
import type { NetTurn } from '../ui/panel';
import { strings } from '../i18n';
import { TURN_TIMEOUT_MS, LOBBY_PRUNE_MS, SKIP_RETRY_MS } from '../config';
import * as session from './online';
import { isBotSeat, scheduleBotMove, clearBotTimer } from './host-bots';
import type { OnlineDeps } from './online-controller';

/** Результат confirm-first (см. контроллер): применили копию (`applied`) или за время
 *  записи прилетел авторитетный чужой стейт и локальное применение пропущено. */
type PushResult = 'applied' | 'superseded';
type ConfirmFirst = (
  base: GameState,
  mutate: (next: GameState) => void,
) => Promise<PushResult>;

/**
 * Зависимости turn-watch: единое состояние приложения по ссылке (deps) + колбэки-
 * поведение. `confirmFirst` — общее confirm-first ядро; `commitOnline` — онлайн-
 * перерисовка (в контроллере, т.к. завершается перевзводом armTurnWatch отсюда же).
 */
export interface TurnWatchDeps {
  deps: OnlineDeps;
  confirmFirst: ConfirmFirst;
  commitOnline(): void;
}

let deps: OnlineDeps;
let confirmFirst: ConfirmFirst;
let commitOnline: () => void;

export function initTurnWatch(h: TurnWatchDeps): void {
  deps = h.deps;
  confirmFirst = h.confirmFirst;
  commitOnline = h.commitOnline;
}

let skipTimer: number | null = null;
let lobbyPruneTimer: number | null = null;
/** Отсчёт остатка времени на ход: момент начала хода (локальные часы) + тикер обновления
 *  метки. Локальный per-client отсчёт (без общего timestamp в стейте) — небольшой разброс
 *  между клиентами допустим для «мягкого» таймера. */
let turnStartAt: number | null = null;
let tickTimer: number | null = null;
/** Показывать ли кнопку ручного пропуска (истинно только для присутствующего игрока). */
let skipVisible = false;
/** Идёт ли запись пропуска (авто/ручного) — защита от дублей. */
let skipSending = false;

export function clearTurnWatch(): void {
  if (skipTimer !== null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
  clearBotTimer(); // ход бота гасится вместе со слежением (host-bots владеет таймером)
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  turnStartAt = null;
  deps.setTurnCountdown(null, false); // снять таймер — иначе завис бы «· 0:00»
  skipVisible = false;
}

/** Снять все таймеры слежения (выход из сессии/закрытие игры). */
export function clearWatches(): void {
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
export function pruneAbsentLobby(): void {
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
export function armTurnWatch(): void {
  clearTurnWatch();
  const game = deps.state.game;
  // mode-гейт (как у scheduleAiMove): presence-событие в лобби зовёт armTurnWatch, но
  // прошлая гонка могла остаться в S.game с phase 'race' (создание нового лобби её не
  // чистит) — без проверки режима в лобби всплывала бы кнопка-таймер чужого/своего хода.
  if (!session.active() || !game || game.phase !== 'race' || deps.state.mode !== 'race')
    return;
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
