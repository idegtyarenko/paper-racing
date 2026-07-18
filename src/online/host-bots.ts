// Боты в онлайне (host-local fill) — конфиг ботов в лобби (число/сложность) и
// расчёт+коммит их ходов хостом. Вынесено из online-controller.ts (god-модуль):
// два обособленных подсистемных куска (боты и слежение за ходом) разъехались по
// отдельным модулям, контроллер остался тонким фасадом.
//
// Хост держит число ботов и их сложность локально; при старте они материализуются в
// замыкающие свободные места (buildStartState) и едут гостям в стейте (Player.bot).
// Гости ботов не ведут — ходы бота считает и коммитит только хост (см. scheduleBotMove).
// Живые игроки приоритетнее: боты не занимают серверных мест лобби, поэтому вошедший
// игрок никогда не блокируется ботом, а lobbyBots пере-клампится по свободным местам.
//
// Не владеет состоянием приложения: читает/мутирует его через переданный на init
// OnlineDeps, а confirm-first/перерисовку/сброс слежения делает переданными колбэками
// (contract-first ядро и commitOnline живут в контроллере, clearTurnWatch — в turn-watch).

import { Track } from '../model/track';
import { GameState, newGame, shuffledIndices, seatColor } from '../model/game';
import { coastMove, applyMove } from '../model/turns';
import { Difficulty, chooseMove } from '../model/ai';
import { renderLobby } from '../ui/lobby';
import { showToast } from '../ui/dialogs';
import { strings } from '../strings';
import { AI_MOVE_DELAY_MS, SKIP_RETRY_MS } from '../config';
import * as session from './online';
import type { OnlineDeps } from './online-controller';

/** Результат confirm-first (см. контроллер): применили копию (`applied`) или за время
 *  записи прилетел авторитетный чужой стейт и локальное применение пропущено. */
type PushResult = 'applied' | 'superseded';
type ConfirmFirst = (
  base: GameState,
  mutate: (next: GameState) => void,
) => Promise<PushResult>;

/**
 * Зависимости host-bots: единое состояние приложения по ссылке (deps) + колбэки-
 * поведение из контроллера/turn-watch. `confirmFirst` — общее confirm-first ядро
 * (клон→mutate→push→identity-guard→setGame); `commitOnline` — онлайн-перерисовка;
 * `clearTurnWatch` — сброс слежения (гасит и наш botTimer) перед перерисовкой панели
 * после хода бота.
 */
export interface HostBotsDeps {
  deps: OnlineDeps;
  confirmFirst: ConfirmFirst;
  commitOnline(): void;
  clearTurnWatch(): void;
}

let deps: OnlineDeps;
let confirmFirst: ConfirmFirst;
let commitOnline: () => void;
let clearTurnWatch: () => void;

export function initHostBots(h: HostBotsDeps): void {
  deps = h.deps;
  confirmFirst = h.confirmFirst;
  commitOnline = h.commitOnline;
  clearTurnWatch = h.clearTurnWatch;
}

// ── Конфиг ботов лобби (host-local) ────────────────────────────────────────────────
let lobbyBots = 0;
let lobbyBotDifficulty: Difficulty = 'medium';
/** Таймер отложенного хода бота (host-only) — гасится вместе со слежением за ходом. */
let botTimer: number | null = null;
/** Идёт ли запись хода бота (host-only) — защита от дублей, как skipSending. */
let botSending = false;

/** Сбросить досаженных ботов (свежее лобби у хоста — без ботов). Сложность не трогаем. */
export function resetBots(): void {
  lobbyBots = 0;
}

/** Погасить таймер отложенного хода бота (зовётся из turn-watch.clearTurnWatch). */
export function clearBotTimer(): void {
  if (botTimer !== null) {
    clearTimeout(botTimer);
    botTimer = null;
  }
}

/** Свободные места лобби под ботов: вместимость трассы минус реальные игроки. */
function freeSeats(): number {
  const cap = deps.state.raceTrack?.startPoints.length ?? 0;
  return Math.max(0, cap - session.getRoster().length);
}

/** Место занято ботом (в идущей гонке)? Бот-ность живёт в стейте (Player.bot). */
export function isBotSeat(game: GameState, seat: number): boolean {
  return !!game.players[seat]?.bot;
}

/**
 * Запланировать ход бота (host-only): пауза AI_MOVE_DELAY_MS, чтобы человек успел
 * следить за ходом бота, как в локальной игре. Один таймер за раз (clearTurnWatch
 * гасит его на каждом ре-планировании слежения).
 */
export function scheduleBotMove(seat: number): void {
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

/** Перерисовать панель лобби по текущему ростеру сессии. */
export function renderLobbyPanel(): void {
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
export function setBotDifficulty(diff: Difficulty): void {
  if (!session.isHost()) return;
  lobbyBotDifficulty = diff;
  renderLobbyPanel();
}

/**
 * Собрать стартовый стейт онлайн-гонки из текущего ростера и host-local конфигурации
 * ботов. Общий для старта из лобби (startOnline) и рематча (rematchOnline) — состав
 * тот же (те же люди + те же боты), меняется лишь случайная раздача стартовых клеток.
 * Стартовые клетки раздаём случайной перестановкой среди всех участников. Это делает
 * только хост, результат уезжает в сериализованном стейте (гости players не
 * пересобирают), поэтому одинаковый сид у клиентов не нужен.
 */
export function buildStartState(raceTrack: Track): GameState {
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
