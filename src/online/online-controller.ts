// Онлайн-флоу поверх online.ts: хост/вход/старт/выход/шаринг + обработчики
// realtime-событий сессии. Всё «сетевое взаимодействие с UI» вынесено из main.ts.
// Контроллер не владеет состоянием приложения (game/mode/raceTrack/editor) —
// читает и мутирует его через переданный на init OnlineDeps, а перерисовку и
// пересчёт делает его же колбэками. Ровно один контроллер на приложение.

import { Track } from '../model/track';
import {
  GameState,
  Candidate,
  Rules,
  newGame,
  cloneState,
  seatColor,
} from '../model/game';
import { coastMove, applyMove, retireSeat } from '../model/turns';
import { EditorState, editorFromTrack } from '../model/editor';
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
import { NetTurn, PanelMode, setMoveSendState } from '../ui/panel';
import { TURN_TIMEOUT_MS, LOBBY_PRUNE_MS, SKIP_RETRY_MS } from '../config';
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
  /** Текущие правила заезда (их задаёт хост; едут в стейте при старте). */
  getRules(): Rules;
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

/**
 * Отправить свой ход (confirm-first): применяем к копии, пишем на сервер и лишь при
 * успехе делаем копию текущим стейтом. Оригинал не трогаем — при ошибке выбор игрока
 * и кандидаты целы, кнопка превращается в «↻ Отправить ещё раз». Identity-guard: если
 * пока шла запись прилетел авторитетный стейт (эхо/чужой ход), локальное применение
 * пропускаем.
 */
export async function sendMove(cand: Candidate): Promise<void> {
  const game = deps.getGame();
  if (!game || game.phase !== 'race' || sending) return;
  if (session.mySeat() !== game.current) return; // уже не мой ход
  sending = true;
  pendingCand = cand;
  setMoveSendState('sending');
  const base = game;
  const next = cloneState(game);
  applyMove(next, cand);
  try {
    await session.pushMove(next);
    sending = false;
    pendingCand = null;
    setMoveSendState('idle');
    if (deps.getGame() !== base) return; // авторитетный стейт уже применился
    deps.setGame(next);
    deps.refreshCands();
    deps.updateUI();
    deps.redraw();
    armTurnWatch();
  } catch {
    sending = false;
    if (deps.getGame() !== base) {
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
  const game = deps.getGame();
  if (!game || game.phase !== 'race' || sending) return;
  const seat = session.mySeat();
  const me = game.players[seat];
  if (!me || me.place !== null || me.retired) return; // уже финишировал/сошёл
  sending = true;
  setMoveSendState('sending');
  const base = game;
  const next = cloneState(game);
  retireSeat(next, seat);
  try {
    await session.pushMove(next);
    sending = false;
    setMoveSendState('idle');
    if (deps.getGame() !== base) return; // авторитетный стейт уже применился
    deps.setGame(next);
    deps.refreshCands();
    deps.updateUI();
    deps.redraw();
    armTurnWatch();
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

/**
 * Активен ли на этом стейте локальный игрок: ещё в гонке — не сдался и не
 * финишировал. Только такие игроки вправе пропускать чужие ходы.
 */
function iAmActive(game: GameState): boolean {
  const me = game.players[session.mySeat()];
  return !!me && me.place === null && !me.retired;
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
    // Пропускать чужой ход может лишь активный игрок (не сдавшийся и не
    // финишировавший) — выбывшие в гонке уже не участвуют.
    if (!iAmActive(game)) return;
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

/**
 * Применить пропуск (confirm-first): болид едет по инерции в копии, пишем на сервер и
 * лишь при успехе делаем её текущим стейтом. При ошибке локально ничего не меняем.
 * Авто-пропуск — тихо перепланируем повтор через SKIP_RETRY_MS (autoSkip сам
 * перепроверит условия); ручной — оставляем кнопку на месте, чтобы можно было нажать снова.
 */
async function applySkip(game: GameState): Promise<void> {
  if (skipSending) return;
  skipSending = true;
  const next = cloneState(game);
  coastMove(next);
  try {
    await session.pushMove(next);
    if (deps.getGame() === game) {
      // Эхо ещё не пришло — применяем сами; иначе авторитетный стейт уже на месте.
      deps.setGame(next);
      clearTurnWatch();
      deps.refreshCands();
      deps.updateUI();
      deps.redraw();
      armTurnWatch();
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
    present: game.players.map((_, i) => session.isPresent(i)),
  };
}

/** Кнопка «Пропустить ход» (доступна, когда истёк таймаут присутствующего игрока). */
export function skip(): void {
  const game = deps.getGame();
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
    // Входящий авторитетный стейт перекрывает наш незавершённый/провалившийся ход:
    // сбрасываем pending-состояние (поздний resolve нашей отправки станет инертным
    // благодаря identity-guard в sendMove, а в БД действует last-write-wins).
    pendingCand = null;
    setMoveSendState('idle');
    deps.setGame(g);
    if (deps.getMode() !== 'race') {
      deps.setMode('race');
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
    if (deps.getMode() === 'lobby') {
      pruneAbsentLobby();
      renderLobbyPanel();
    }
    deps.updateUI();
  },
};

/** Создать онлайн-игру (хост) с введённым именем и открыть лобби. */
function hostOnline(name: string): Promise<void> {
  return guarded(async () => {
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
 * Хост стартует онлайн-гонку (confirm-first): строит стейт, сначала пишет его на
 * сервер и только при успехе входит в гонку. При ошибке остаёмся в лобби — «Начать
 * игру» снова активна, гости ничего не увидели (записи не было).
 */
function startOnline(): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.getRaceTrack();
    if (!raceTrack || !session.canStart()) return;
    const roster = session.getRoster();
    const g = newGame(raceTrack, roster.length, deps.getRules());
    roster.forEach((r, i) => {
      if (g.players[i]) g.players[i].name = r.name;
    });
    setLobbyStarting(true);
    try {
      await session.start(g);
      if (deps.getMode() !== 'race') {
        // Эхо собственной записи могло уже перевести в гонку — не дублируем.
        deps.setGame(g);
        deps.setMode('race');
        deps.fitToContent();
        deps.refreshCands();
        deps.updateUI();
        deps.redraw();
        armTurnWatch();
      }
    } catch {
      showToast(strings.online.startFailed);
    } finally {
      setLobbyStarting(false);
    }
  });
}

/** Выйти из лобби: освободить место на сервере и вернуться (хост — к выбору режима). */
function leaveLobby(): Promise<void> {
  return guarded(async () => {
    clearWatches();
    pendingCand = null;
    setMoveSendState('idle');
    setConnBanner(false);
    setLobbyStarting(false);
    const wasHost = deps.getRaceTrack() !== null;
    await session.leave();
    if (wasHost) {
      deps.setMode('mode');
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
