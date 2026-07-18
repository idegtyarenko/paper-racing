// Онлайн-флоу поверх online.ts: хост/вход/старт/выход/шаринг + обработчики
// realtime-событий сессии. Всё «сетевое взаимодействие с UI» вынесено из main.ts.
// Контроллер не владеет состоянием приложения (game/mode/raceTrack/editor) —
// читает и мутирует его через переданный на init OnlineDeps, а перерисовку и
// пересчёт делает его же колбэками. Ровно один контроллер на приложение.
//
// Два обособленных подсистемных куска вынесены в соседние модули (был god-модуль):
//   • turn-watch.ts — слежение за ходом, countdown, ручной/авто-пропуск, прунинг лобби;
//   • host-bots.ts — конфиг ботов в лобби и расчёт+коммит их ходов хостом.
// Контроллер раздаёт им общее состояние (deps) и confirm-first/commitOnline через init.

import { GameState, Candidate, cloneState, isFinished } from '../model/game';
import { applyMove, retireSeat } from '../model/turns';
import { editorFromTrack } from '../model/editor';
import { setLobbyStarting } from '../ui/lobby';
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
import { setMoveSendState } from '../ui/panel';
import { strings } from '../strings';
import * as session from './online';
import { OnlineHandlers } from './online';
import * as hostBots from './host-bots';
import * as turnWatch from './turn-watch';

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
  // Раздать под-модулям общее состояние и confirm-first/commitOnline. host-bots ещё
  // получает clearTurnWatch (чтобы сбросить слежение перед перерисовкой после хода бота).
  hostBots.initHostBots({
    deps: d,
    confirmFirst,
    commitOnline,
    clearTurnWatch: turnWatch.clearTurnWatch,
  });
  turnWatch.initTurnWatch({ deps: d, confirmFirst, commitOnline });
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
 * Раздаётся в turn-watch/host-bots через init (applySkip/runBotMove тоже им пользуются).
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
 * Онлайн-аналог локального commit(): пересчёт кандидатов → панель → канвас →
 * перевзвод слежения за ходом (armTurnWatch). Звать после того, как setGame сделал
 * свой/входящий стейт текущим. Отличается от main.commit тем, что вместо
 * scheduleAiMove завершается armTurnWatch (онлайн-специфика: таймер хода, авто-пропуск,
 * ход бота у хоста). onGameState не использует — там особый порядок (armTurnWatch до
 * updateUI, чтобы skipVisible сбросился под новый ход). Раздаётся в turn-watch/host-bots.
 */
function commitOnline(): void {
  deps.refreshCands();
  deps.updateUI();
  deps.redraw();
  turnWatch.armTurnWatch();
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

const handlers: OnlineHandlers = {
  onLobby: () => {
    // Мы в живом лобби — запомним код для возврата после дисконнекта (идемпотентно).
    rememberSession(session.getCode()!);
    if (deps.state.mode === 'lobby') hostBots.renderLobbyPanel();
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
    turnWatch.armTurnWatch();
    deps.updateUI();
    deps.redraw();
  },
  onClosed: () => {
    turnWatch.clearWatches();
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
    turnWatch.armTurnWatch();
    if (deps.state.mode === 'lobby') {
      turnWatch.pruneAbsentLobby();
      hostBots.renderLobbyPanel();
    }
    deps.updateUI();
  },
};

/** Создать онлайн-игру (хост) с введённым именем и открыть лобби. */
function hostOnline(name: string): Promise<void> {
  return guarded(async () => {
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack) return;
    hostBots.resetBots(); // свежее лобби — без досаженных ботов
    try {
      await session.host(raceTrack, name, handlers);
      deps.state.mode = 'lobby';
      deps.updateUI();
      hostBots.renderLobbyPanel();
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
      if (deps.state.mode === 'lobby') hostBots.renderLobbyPanel();
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
    const raceTrack = deps.state.raceTrack;
    if (!raceTrack || !session.canStart()) return;
    const g = hostBots.buildStartState(raceTrack);
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
    const g = hostBots.buildStartState(raceTrack);
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
    turnWatch.clearWatches();
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

// Публичное API под-модулей, которым пользуется main.ts, — через контроллер-фасад:
// ход-контекст/пропуск (turn-watch) и управление ботами в лобби (host-bots).
export { skip, netTurn } from './turn-watch';
export { addBot, removeBot, setBotDifficulty } from './host-bots';
