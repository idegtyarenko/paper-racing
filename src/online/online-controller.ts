// Онлайн-флоу поверх online.ts: хост/вход/старт/выход/шаринг + обработчики
// realtime-событий сессии. Всё «сетевое взаимодействие с UI» вынесено из main.ts.
// Контроллер не владеет состоянием приложения (game/mode/raceTrack/editor) —
// читает и мутирует его через переданный на init OnlineDeps, а перерисовку и
// пересчёт делает его же колбэками. Ровно один контроллер на приложение.

import { Track } from '../model/track';
import { GameState, newGame, coastMove, seatColor } from '../model/game';
import { EditorState, editorFromTrack } from '../model/editor';
import { renderLobby } from '../ui/lobby';
import { openNameDialog, openJoinDialog, showJoinError, showToast } from '../ui/dialogs';
import { closeOverlay } from '../ui/dom';
import { NetTurn, PanelMode } from '../ui/panel';
import { TURN_TIMEOUT_MS, LOBBY_PRUNE_MS } from '../config';
import { strings } from '../strings';
import * as session from './online';
import { OnlineHandlers } from './online';

/** Мост к состоянию и флоу главного модуля: контроллер не держит их сам. */
export interface OnlineDeps {
  getMode(): PanelMode;
  setMode(m: PanelMode): void;
  getRaceTrack(): Track | null;
  setRaceTrack(t: Track | null): void;
  getGame(): GameState | null;
  setGame(g: GameState): void;
  setEditor(e: EditorState): void;
  /** Вписать текущее содержимое (трассу) по центру вьюпорта. */
  fitToContent(): void;
  refreshCands(): void;
  updateUI(): void;
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
    if (!e.persisted && deps.getMode() === 'lobby') session.leave();
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
/** Показывать ли кнопку ручного пропуска (истинно только для присутствующего игрока). */
let skipVisible = false;

function clearTurnWatch(): void {
  if (skipTimer !== null) {
    clearTimeout(skipTimer);
    skipTimer = null;
  }
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
      if (deps.getMode() === 'lobby') pruneAbsentLobby();
    }, soonest);
  }
}

/** Пересчитать слежение за текущим ходом. Зовётся на каждый стейт и presence-событие. */
function armTurnWatch(): void {
  clearTurnWatch();
  const game = deps.getGame();
  if (!session.active() || !game || game.phase !== 'race') return;
  const cur = game.current;
  if (cur === session.mySeat()) return; // мой ход — не слежу за собой

  if (session.isPresent(cur)) {
    // Онлайн, но задумался — через 30 с открываем ручной пропуск остальным.
    skipTimer = window.setTimeout(() => {
      skipVisible = true;
      deps.updateUI();
    }, TURN_TIMEOUT_MS);
    return;
  }
  // Отсутствует: авто-пропуск выполняет назначенный присутствующий клиент.
  if (session.designatedSkipper() !== session.mySeat()) return;
  const left = session.leftAtOf(cur);
  const grace =
    left === null ? TURN_TIMEOUT_MS : Math.max(0, TURN_TIMEOUT_MS - (Date.now() - left));
  skipTimer = window.setTimeout(() => autoSkip(cur), grace);
}

/** Авто-пропуск отсутствующего игрока (если он всё ещё офлайн и ходит сейчас). */
function autoSkip(seat: number): void {
  const game = deps.getGame();
  if (!game || game.phase !== 'race' || game.current !== seat) return;
  if (session.isPresent(seat)) return; // вернулся — ждём его самого
  if (session.designatedSkipper() !== session.mySeat()) return;
  applySkip(game);
}

/** Применить пропуск: болид едет по инерции, локально обновляемся и рассылаем стейт. */
function applySkip(game: GameState): void {
  coastMove(game);
  clearTurnWatch();
  deps.refreshCands();
  deps.updateUI();
  deps.redraw();
  session.pushMove(game).catch(() => showToast(strings.online.error));
  // Следующий ход переарм-ится эхом собственной записи (onGameState).
}

/** Онлайн-контекст текущего хода для панели: чей ход, мой ли, можно ли пропустить,
 *  кто сейчас офлайн. Null — если не в онлайн-игре. */
export function netTurn(game: GameState | null): NetTurn | null {
  if (!session.active() || !game) return null;
  return {
    yourTurn: session.mySeat() === game.current,
    canSkip: skipVisible,
    currentName: game.players[game.current]?.name ?? '',
    present: game.players.map((_, i) => session.isPresent(i)),
  };
}

/** Кнопка «Пропустить ход» (доступна, когда истёк таймаут присутствующего игрока). */
export function skip(): void {
  const game = deps.getGame();
  if (!game || game.phase !== 'race' || !skipVisible) return;
  if (game.current === session.mySeat()) return;
  applySkip(game);
}

function savedName(): string {
  return localStorage.getItem('pr-player-name') ?? '';
}
function rememberName(n: string): void {
  localStorage.setItem('pr-player-name', n);
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
  });
}

const handlers: OnlineHandlers = {
  onLobby: () => {
    if (deps.getMode() === 'lobby') renderLobbyPanel();
  },
  onGameState: (g) => {
    deps.setGame(g);
    if (deps.getMode() !== 'race') {
      deps.setMode('race');
      closeOverlay();
      deps.fitToContent();
    }
    deps.refreshCands();
    deps.updateUI();
    deps.redraw();
    armTurnWatch();
  },
  onClosed: () => {
    clearWatches();
    showToast(strings.online.closed);
    deps.resetToEdit();
  },
  onPresence: () => {
    // Присутствие влияет на «ждать/пропускать» и на метки офлайна в панели/лобби;
    // в лобби ещё и вычищаем брошенные места.
    armTurnWatch();
    if (deps.getMode() === 'lobby') {
      pruneAbsentLobby();
      renderLobbyPanel();
    }
    deps.updateUI();
  },
};

/** Создать онлайн-игру (хост) с введённым именем и открыть лобби. */
async function hostOnline(name: string): Promise<void> {
  const raceTrack = deps.getRaceTrack();
  if (!raceTrack) return;
  try {
    await session.host(raceTrack, name, handlers);
    deps.setMode('lobby');
    deps.updateUI();
    renderLobbyPanel();
    deps.redraw();
  } catch {
    showToast(strings.online.error);
  }
}

/**
 * Присоединиться к онлайн-игре по коду. inJoinDialog — ошибку показываем прямо в
 * диалоге входа (он остаётся открыт); иначе (вход по ссылке) — тостом.
 */
async function joinOnline(
  code: string,
  name: string,
  inJoinDialog: boolean,
): Promise<void> {
  try {
    await session.join(code, name, handlers);
    closeOverlay();
    const t = session.getTrack();
    if (t) {
      deps.setEditor(editorFromTrack(t)); // превью трассы хоста в лобби
      deps.setRaceTrack(null); // гость не владеет трассой
    }
    // Реконнект в уже идущую гонку: onGameState уже перевёл в режим race —
    // не сбрасываем обратно в лобби. Иначе (игра ещё не начата) — в лобби.
    if (deps.getMode() !== 'race') deps.setMode('lobby');
    deps.fitToContent(); // вписать трассу хоста по центру
    deps.redraw();
    deps.updateUI();
    if (deps.getMode() === 'lobby') renderLobbyPanel();
  } catch (e) {
    if (inJoinDialog) showJoinError(joinErrorText(e));
    else showToast(joinErrorText(e));
  }
}

/** Хост стартует онлайн-гонку: строит стейт с именами игроков и рассылает его. */
async function startOnline(): Promise<void> {
  const raceTrack = deps.getRaceTrack();
  if (!raceTrack || !session.canStart()) return;
  const roster = session.getRoster();
  const g = newGame(raceTrack, roster.length);
  roster.forEach((r, i) => {
    if (g.players[i]) g.players[i].name = r.name;
  });
  deps.setGame(g);
  deps.setMode('race');
  deps.fitToContent();
  deps.refreshCands();
  deps.updateUI();
  deps.redraw();
  try {
    await session.start(g);
  } catch {
    showToast(strings.online.error);
  }
}

/** Выйти из лобби: освободить место на сервере и вернуться (хост — к выбору режима). */
async function leaveLobby(): Promise<void> {
  clearWatches();
  const wasHost = deps.getRaceTrack() !== null;
  await session.leave();
  if (wasHost) {
    deps.setMode('mode');
    deps.updateUI();
    deps.redraw();
  } else {
    deps.resetToEdit();
  }
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

export function start(): void {
  startOnline();
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
