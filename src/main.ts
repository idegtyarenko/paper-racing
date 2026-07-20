// Оркестрация: состояние приложения, переключение фаз редактор/гонка, сборка
// зависимостей ввода/онлайна/кнопок. Сами жесты указателя живут в input.ts.
// Всё игровое состояние собрано в одном объекте `S` (app-state.ts); онлайн и ввод
// читают и мутируют его по ссылке через deps.state — отдельных get/set-переходников
// на каждое поле больше нет.

import './ui/styles/index.css';
import { newAppState, PanelMode } from './app-state';
import { finalizeTrack } from './model/track';
import { newEditor, stepBack, confirmEdges } from './model/editor';
import {
  Candidate,
  normalizeRules,
  newGame,
  shuffledIndices,
  isFinished,
} from './model/game';
import { candidatesForSeat, applyMove, coastMove, retireSeat } from './model/turns';
import { Difficulty, chooseMove } from './model/ai';
import { buildNavField } from './model/nav';
import { strings, localeTag, dateLocale } from './i18n';
import { AI_MOVE_DELAY_MS } from './config';
import { render, AppView } from './view/render';
import { Bounds, polylineBounds } from './view/camera';
import * as vp from './view/viewport';
import {
  bindButtons,
  updatePanel,
  setOnlineEnabled,
  setTurnCountdown,
  showConfirmMove,
} from './ui/panel';
import { renderTurnQueue } from './ui/turn-queue';
import { renderStandings } from './ui/standings';
import { openSettings } from './ui/settings';
import { localizeDom } from './ui/localize';
import { onlineAvailable } from './online/net';
import * as session from './online/online';
import * as online from './online/online-controller';
import * as input from './view/input';
import { initInstallPrompt } from './ui/install-prompt';
import { showToast } from './ui/dialogs';
import { initPwa } from './pwa';
import * as persist from './persist';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const wrap = document.querySelector('.app__board')!;

/** Единое состояние приложения (см. app-state.ts). Онлайн/ввод получают его по
 *  ссылке и читают/пишут поля напрямую. */
const S = newAppState();
/** Таймер отложенного хода бота — не состояние, а служебная ручка: остаётся
 *  приватным в main.ts, в коробку S не кладём. Гасится при любом выходе из гонки. */
let aiTimer: number | null = null;

/** Место за ботом (и какой сложности)? Бот-ность живёт в стейте (Player.bot). */
function isBotSeat(i: number): boolean {
  return !!S.game?.players[i]?.bot;
}

/** Bbox содержимого для fit/clamp: трасса гонки или редактируемая трасса.
 *  Провайдер границ для вьюпорта — «что сейчас на экране» знает приложение. */
function contentBounds(): Bounds | null {
  if (S.mode === 'race' && S.game)
    return polylineBounds(S.game.track.outer, S.game.track.inner);
  return polylineBounds(S.editor.outer, S.editor.inner, S.editor.center);
}

/** Пересчитать вьюпорт под новый размер поля и перерисовать. */
function resize(): void {
  vp.resize();
  redraw();
}

function redraw(): void {
  // Шаг выбора игроков рисуется как редактор: показываем готовую трассу-превью.
  const viewMode = S.mode === 'race' ? 'race' : 'edit';
  const app: AppView = {
    mode: viewMode,
    editor: S.editor,
    game: S.game,
    cands: S.cands,
    hover: input.getHover(),
    selected: input.getSelected(),
    pending: S.pending,
    candSeat: candOwner(),
    loupe: input.getLoupe(),
    cam: vp.camera(),
  };
  render(ctx, app);
}

/**
 * Единственное человеческое место в локальной игре (все прочие — боты): это тот,
 * кому показываем веер кандидатов/наметку в ход бота. −1, если людей не ровно один
 * (hotseat: несколько людей — предвыбор не применяется). Онлайн сюда не смотрит.
 */
function soloHumanSeat(): number {
  if (!S.game) return -1;
  let seat = -1;
  for (let i = 0; i < S.game.players.length; i++) {
    if (S.game.players[i].bot) continue;
    if (seat !== -1) return -1; // второй человек — это hotseat, не vs-боты
    seat = i;
  }
  return seat;
}

/**
 * Место, для которого показываем веер кандидатов и разрешаем наметку, — независимо
 * от того, чей сейчас ход: онлайн → своё место; локально vs-боты → единственный
 * человек. Требуем, чтобы место было активно (не в гравии, не финишировало, не
 * сдалось). −1 — предвыбор недоступен (в т.ч. hotseat). При своём ходе совпадает с
 * game.current, так что обычная игра идёт тем же путём.
 */
function preselectSeat(): number {
  if (S.mode !== 'race' || !S.game || S.game.phase !== 'race') return -1;
  const seat = session.active() ? session.mySeat() : soloHumanSeat();
  if (seat < 0) return -1;
  const p = S.game.players[seat];
  if (isFinished(p) || p.retired || p.skipTurns !== 0) return -1;
  return seat;
}

/**
 * Место, чей веер кандидатов сейчас показываем/с которым взаимодействуем: в свой ход —
 * ходящий (`game.current`) в любом режиме (hotseat/vs-боты/онлайн); в чужой ход — место
 * предвыбора (`preselectSeat`, только онлайн/vs-боты). −1 — кандидатов нет (чужой ход в
 * hotseat, штраф, вне гонки). При своём ходе даёт тот же веер, что и раньше.
 */
function candOwner(): number {
  if (!S.game || S.game.phase !== 'race') return -1;
  if (myTurn())
    return S.game.players[S.game.current].skipTurns === 0 ? S.game.current : -1;
  return preselectSeat();
}

/**
 * Место локального игрока, который сдаётся кнопкой «Сдаться»: в онлайне — своё
 * место; локально — текущий ходящий, если это человек (на ходе бота сдаваться
 * некому — кнопка скрыта). −1, если гонки нет или сейчас ходит бот.
 */
function localHumanSeat(): number {
  if (!S.game) return -1;
  if (session.active()) return session.mySeat();
  return isBotSeat(S.game.current) ? -1 : S.game.current;
}

/** Доступна ли сейчас кнопка «Сдаться»: идёт гонка и локальный игрок ещё в ней
 *  (не финишировал и не сошёл). Сдаться можно в любой момент, не только в свой ход. */
function canRetire(): boolean {
  if (!S.game || S.mode !== 'race' || S.game.phase !== 'race') return false;
  const seat = localHumanSeat();
  return seat >= 0 && !isFinished(S.game.players[seat]) && !S.game.players[seat].retired;
}

function updateUI(): void {
  const net = online.netTurn(S.game);
  const aiTurn = !!S.game && isBotSeat(S.game.current);
  updatePanel({
    mode: S.mode,
    editor: S.editor,
    game: S.game,
    playersMax: S.raceTrack?.startPoints.length ?? 6,
    net,
    aiTurn,
    canRetire: canRetire(),
  });
  renderTurnQueue(S.mode === 'race' ? S.game : null);
  renderStandings(S.mode === 'race' ? S.game : null, S.raceNav);
}

/** Может ли этот клиент ходить сейчас: в локальной игре — всегда (кроме хода
 *  бота), в онлайне — на своём месте. */
function myTurn(): boolean {
  if (S.game && isBotSeat(S.game.current)) return false;
  if (!session.active()) return true;
  return S.game !== null && session.mySeat() === S.game.current;
}

function cancelAiMove(): void {
  if (aiTimer !== null) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
}

/**
 * Цикл ходов ботов в ЛОКАЛЬНОЙ игре: если сейчас очередь бота, походить им после
 * короткой паузы (человек успевает следить) и продолжить, пока очередь не вернётся
 * к человеку или гонка не кончится. В онлайне не работает — там ходы ботов считает
 * и коммитит хост через online-controller (иначе локальный applyMove разошёлся бы
 * с сервером). Пауза сбрасывается при выходе из гонки (cancelAiMove).
 */
function scheduleAiMove(): void {
  if (aiTimer !== null || session.active()) return;
  // mode-гейт: бот ходит только в открытой гонке. Пока открыт экран настройки
  // (mode !== 'race'), боты на паузе, даже если game ещё в phase 'race'. Без этой
  // проверки commit() из меню-переходов запускал бы ход бота под настройками.
  if (
    S.mode !== 'race' ||
    !S.game ||
    S.game.phase !== 'race' ||
    !isBotSeat(S.game.current)
  )
    return;
  aiTimer = window.setTimeout(() => {
    aiTimer = null;
    if (!S.game || S.game.phase !== 'race' || !isBotSeat(S.game.current) || !S.raceNav)
      return;
    const cand = chooseMove(S.game, S.raceNav, S.game.players[S.game.current].bot!);
    if (cand) applyMove(S.game, cand);
    else coastMove(S.game); // все кандидаты заняты соперниками — пас по инерции
    commit();
  }, AI_MOVE_DELAY_MS);
}

/**
 * Единая точка «состояние изменилось — привести экран в порядок»: пересчёт
 * кандидатов → панель → канвас → (если локальная гонка с ботами) следующий ход
 * бота. Звать после любой мутации локального состояния вместо ручной связки
 * refreshCands/updateUI/redraw/scheduleAiMove — так шаг нельзя забыть или
 * переставить. `fit` дополнительно вписывает содержимое в кадр (старт гонки).
 * Онлайн ведёт свою перерисовку через commitOnline (там нужен armTurnWatch).
 */
function commit(opts: { fit?: boolean } = {}): void {
  if (opts.fit) vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove();
}

/**
 * Применить выбранный ход: локально мутируем стейт, а в онлайне ещё и отправляем
 * его остальным. Не даём ходить не в свой ход / не в фазе гонки.
 */
function commitMove(cand: Candidate): void {
  if (!S.game || S.game.phase !== 'race' || !myTurn()) return;
  S.pending = null; // ход сделан — наметка отыграна
  if (session.active()) {
    // Онлайн: confirm-first — локальный стейт двинется только после успешной записи
    // (см. online.sendMove), чтобы при обрыве ход не потерялся и его можно было повторить.
    online.sendMove(cand);
    return;
  }
  applyMove(S.game, cand);
  commit(); // в гонке с ботами после хода человека очередь едет к ботам
}

/**
 * Сдаться: локальный игрок выбывает из гонки. Доступно в любой момент (не только
 * в свой ход). В онлайне — confirm-first отправка; локально — мутируем стейт и
 * перерисовываем. Кнопку показываем/прячем по canRetire().
 */
function retire(): void {
  if (!canRetire()) return;
  if (session.active()) {
    online.sendRetire();
    return;
  }
  retireSeat(S.game!, localHumanSeat());
  commit(); // после выбытия человека очередь может уйти к ботам
}

function refreshCands(): void {
  input.clearSelection();
  const seat = candOwner();
  if (seat < 0) {
    S.cands = null;
    S.pending = null;
    return;
  }
  // В свой ход seat === game.current (обычная игра); в чужой ход (онлайн/vs-боты) —
  // своё место, чтобы наметить ход заранее.
  S.cands = candidatesForSeat(S.game!, seat);
  revalidatePending();
  // Курсор мог стоять на точке, пока прилетел чужой ход (предвыбор) — восстанавливаем
  // наведение по реальной позиции мыши, иначе clearSelection выше погасил бы его.
  input.reaimHover();
  // Наметка дожила до своего хода — вооружаем «Газу!», чтобы подтвердить одним тапом.
  if (myTurn() && S.pending) showConfirmMove(true, input.confirmAnchor());
}

/**
 * Проверить наметку против свежего состояния: если намеченная точка стала занята
 * соперником (встал в неё или на путь — blocked) либо аварийной, наметку сбрасываем
 * с тостом; иначе обновляем ссылку на актуальный кандидат. Зовётся из refreshCands —
 * единой воронки входящих состояний (onGameState в онлайне, цикл ботов локально).
 */
function revalidatePending(): void {
  if (!S.pending || !S.cands) return;
  const t = S.pending.target;
  const match = S.cands.find((c) => c.target.x === t.x && c.target.y === t.y);
  if (match && !match.blocked && !match.crash) {
    S.pending = match;
  } else {
    S.pending = null;
    showToast(strings.race.preselectCleared);
  }
}

/**
 * Перейти к шагу выбора режима игры. Из редактора («edit») сначала финализируем
 * нарисованную трассу; если не удалось — показываем ошибку и остаёмся в редакторе.
 * Из гонки («race», «та же трасса») берём готовую трассу текущей гонки. Экран
 * выбора режима показывается всегда, даже без онлайна — там же выбор «С компьютером».
 */
function goToMode(from: 'edit' | 'race'): void {
  if (from === 'edit') {
    const res = finalizeTrack(
      S.editor.outer!,
      S.editor.inner!,
      S.editor.finish!,
      S.editor.forward!,
    );
    if ('error' in res) {
      S.editor.message = res.error;
      S.editor.error = true;
      commit();
      return;
    }
    S.raceTrack = res.track;
  } else {
    if (!S.game) return;
    S.raceTrack = S.game.track;
  }
  S.playersReturn = from;
  cancelAiMove(); // гонка с ботами на паузе, пока открыты экраны настройки
  S.mode = 'mode';
  commit();
}

/** Назад из шага настройки (режим/игроки): в редактор или к текущей гонке. */
function backFromSetup(): void {
  if (S.playersReturn === 'race') {
    S.mode = 'race'; // commit() ниже возобновит ходы ботов (mode-гейт в scheduleAiMove)
  } else {
    S.mode = 'edit';
    stepBack(S.editor); // ready → direction
  }
  S.raceTrack = null;
  commit();
}

/**
 * Стартовать локальную гонку на подготовленной трассе: сначала `humans` мест за
 * людьми, следом `bots` мест за ботами заданной сложности. Боты садятся в
 * замыкающие места (seat), но стартовые клетки раздаются случайной перестановкой
 * среди всех участников — так что поул может достаться и боту (место старта больше
 * не привязано к тому, кто раньше «зашёл»). Общее число участников зажимается по
 * стартовой решётке в newGame; `difficulty` не важен при bots = 0. Бот раскрывает
 * ходы тем же генератором целей, что и движок, поэтому играет физику самого заезда
 * — отдельной «классики для бота» нет.
 */
function startRace(humans: number, bots: number, difficulty: Difficulty): void {
  if (!S.raceTrack) return;
  cancelAiMove();
  S.pending = null;
  S.game = newGame(S.raceTrack, humans + bots, S.rules, shuffledIndices(humans + bots));
  for (let i = humans; i < S.game.players.length; i++) {
    S.game.players[i].bot = difficulty;
    S.game.players[i].name = `${strings.aiSelect.botPrefix} ${S.game.players[i].name}`;
  }
  S.raceNav = buildNavField(S.raceTrack); // нужно ботам (chooseMove) и полосе мест
  S.lastLocalRace = { humans, bots, difficulty };
  S.mode = 'race';
  commit({ fit: true }); // fit вписывает трассу в кадр; scheduleAiMove — если первым ходит бот
}

/** Сбросить всё к чистому редактору (новая трасса / выход из онлайна). */
function resetToEdit(): void {
  // Если ещё в онлайн-сессии (например, финишировал, а другой игрок ещё гоняет,
  // и жмёшь «Новый заезд» → «Начертить новую») — выходим из неё, иначе прилетевший
  // ход соперника через onGameState реанимировал бы гонку и выдернул из редактора.
  if (session.active()) session.leave();
  cancelAiMove();
  S.game = null;
  S.raceNav = null;
  S.raceTrack = null;
  S.cands = null;
  S.pending = null;
  input.clearSelection();
  S.editor = newEditor();
  S.mode = 'edit';
  // Пустое поле → resize() покажет дефолтный вид (границ содержимого нет).
  updateUI();
  resize();
}

// Онлайн-флоу (host/join/start/leave/share) вынесен в online-controller.ts;
// он читает и мутирует состояние приложения S по ссылке, а перерисовку/сброс делает
// колбэками. setGame — колбэк (а не запись в S.game): у него побочные эффекты.
online.initOnline({
  state: S,
  setGame: (g) => {
    // Онлайн-гонка заменяет локальную: гасим локальный цикл ботов (в онлайне их ведёт
    // хост через online-controller). Бот-ность самих мест едет в стейте g (Player.bot).
    cancelAiMove();
    S.game = g;
    S.raceNav = g ? buildNavField(g.track) : null; // ботам (chooseMove) и полосе мест
    S.lastLocalRace = null; // онлайн-гонка — не локальный рематч, сбрасываем «ту же трассу»
  },
  fitToContent: () => vp.fitToContent(),
  refreshCands,
  updateUI,
  setTurnCountdown,
  redraw,
  resetToEdit,
});

// Жесты указателя и зум вынесены в input.ts; он читает состояние приложения S по
// ссылке и применяет ходы через эти колбэки, а подсветку (hover/selected/loupe) держит сам.
input.initInput({
  canvas,
  state: S,
  commitMove,
  // Предвыбор: сейчас не мой ход, но своё место может намечать (онлайн/vs-боты).
  isPreselect: () => !myTurn() && candOwner() >= 0,
  setPending: (cand) => {
    S.pending = cand;
    showConfirmMove(false); // не мой ход — кнопку не показываем, наметка видна на поле
    redraw();
  },
  goToMode,
  updateUI,
  redraw,
});

bindButtons({
  onBack: () => {
    stepBack(S.editor);
    commit();
  },
  onNext: () => {
    confirmEdges(S.editor);
    commit();
  },
  onConfirmMove: () => {
    const sel = input.getSelected();
    if (sel) commitMove(sel);
    // Свой ход с дожившей наметкой: «Газу!» коммитит её без повторного тапа.
    else if (S.pending && myTurn()) commitMove(S.pending);
    else online.retryMove(); // десктоп: выделение не хранится — повторяем последний ход
  },
  // «Рематч» одним тапом: тот же состав на той же трассе, без мастера. В онлайне
  // (хост) переигрываем ту же комнату; локально — повтор сохранённого состава.
  // Кнопка видна только при canRematch, но защищаемся и здесь.
  onChooseSameTrack: () => {
    if (session.active()) {
      online.rematch();
      return;
    }
    if (!S.game || !S.lastLocalRace) return;
    S.raceTrack = S.game.track;
    startRace(S.lastLocalRace.humans, S.lastLocalRace.bots, S.lastLocalRace.difficulty);
  },
  // «Та же трасса, другой режим»: сохранить трассу, заново выбрать режим/игроков.
  onSameTrackNewMode: () => goToMode('race'),
  canRematch: () => (!!S.game && !!S.lastLocalRace) || online.canRematch(),
  isOnline: () => session.active(),
  onPlayersBack: () => {
    // С экрана числа игроков назад — к выбору режима (он теперь есть всегда).
    S.mode = 'mode';
    commit();
  },
  onStartLocal: (humans, bots, difficulty) => startRace(humans, bots, difficulty),
  onOpenSettings: () =>
    openSettings(S.rules, false, (r) => {
      S.rules = r;
    }),
  onLobbySettings: () =>
    openSettings(S.rules, true, (r) => {
      S.rules = r;
    }),
  onNewTrack: () => resetToEdit(),
  onModeLocal: () => {
    S.mode = 'players';
    commit();
  },
  onModeOnline: () => online.promptCreate(),
  onModeAI: () => {
    S.mode = 'ai';
    commit();
  },
  onAiBack: () => {
    S.mode = 'mode';
    commit();
  },
  onModeBack: () => backFromSetup(),
  onJoinByCode: () => online.promptJoin(),
  onLobbyStart: () => online.start(),
  onLobbyShare: () => online.share(),
  onLobbyCopyCode: () => online.copy(),
  onLobbyBotAdd: () => online.addBot(),
  onLobbyBotRemove: () => online.removeBot(),
  onLobbyBotDifficulty: (d) => online.setBotDifficulty(d),
  onLobbyLeave: () => online.leave(),
  onSkip: () => online.skip(),
  onRaceShare: () => online.share(),
  onRetire: () => retire(),
});

/**
 * Сохранить локальное состояние игры, чтобы перезагрузка/жест «назад»/сворачивание
 * вкладки не сбрасывали игру к первому экрану. Онлайн-сессию не сохраняем (она
 * живёт на сервере) — вместо этого стираем прошлый локальный снимок. persist сам
 * берёт из S лишь персистентное подмножество (cands/pending/raceNav не пишутся).
 */
function saveState(): void {
  if (session.active()) {
    persist.clear();
    return;
  }
  persist.save(S);
}

/** Восстановить локальное состояние из снимка. Возвращает восстановленный режим
 *  (или null, если снимка не было). */
function restoreState(): PanelMode | null {
  const snap = persist.load();
  if (!snap) return null;
  S.mode = snap.mode;
  S.editor = snap.editor;
  S.raceTrack = snap.raceTrack;
  S.game = snap.game;
  // Бэкфилл дефолтами: снимок мог быть записан старой версией без новых полей
  // правил (напр. turnLimitMs) — иначе они окажутся undefined. Так же чинит
  // серверные стейты net.ts при десериализации.
  S.rules = normalizeRules(snap.rules);
  S.playersReturn = snap.playersReturn;
  S.lastLocalRace = snap.lastLocalRace;
  // nav-поле не сериализуем — пересобираем из трассы (нужно ботам и полосе мест).
  // Бот-ность мест едет внутри game.players (Player.bot) — отдельно не восстанавливаем.
  if (S.game) S.raceNav = buildNavField(S.game.track);
  return snap.mode;
}

// Мобильный swipe-to-reload, жест/кнопка «назад», закрытие или сворачивание вкладки:
// pagehide ловит выгрузку и уход в bfcache, visibilitychange — сворачивание (на
// телефоне самое надёжное, вкладку могут выгрузить из фона без pagehide).
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
});

// Заполнить статичные тексты разметки из strings до первого показа панели, и выставить
// язык документа под активную локаль (в разметке дефолт lang="en").
document.documentElement.lang = localeTag;
localizeDom();

// Метка сборки внизу шторки «Правила» — честный признак, какой код сейчас крутится
// (строка вкомпилирована в бандл): коммит + время сборки. Время форматируем в
// локальный час, чтобы «только что» совпадало с настенным временем.
const buildLabel = new Date(__BUILD_TIME__).toLocaleString(dateLocale, {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
document.getElementById('appVersion')!.textContent = `${__COMMIT__} · ${buildLabel}`;

// Если коммит сменился с прошлого запуска — приложение обновилось: покажем тост.
// Сравниваем вкомпилированный коммит с сохранённым, не завязываясь на механику SW.
try {
  const BUILD_KEY = 'pr-build';
  const seen = localStorage.getItem(BUILD_KEY);
  if (seen && seen !== __COMMIT__) {
    showToast(strings.race.updated, 3000);
  }
  localStorage.setItem(BUILD_KEY, __COMMIT__);
} catch {
  // приватный режим/недоступный localStorage — молча пропускаем
}

// Онлайн-входы показываем только если бэкенд настроен (иначе — только локальная игра).
setOnlineEnabled(onlineAvailable());

// Камера: связать вьюпорт с canvas/обёрткой и провайдером границ содержимого.
vp.initViewport(canvas, wrap, contentBounds);

// ResizeObserver вместо window.resize: обёртка меняет размер и при смене
// раскладки (портрет/ландшафт на мобильных), а не только окна.
new ResizeObserver(resize).observe(wrap);

// Открыта ссылка-приглашение (?join=CODE) — подключиться к игре (при повторном
// входе имя уже известно, иначе спросим). Иначе — восстановить локальную игру,
// сохранённую перед прошлой выгрузкой страницы.
const joinParam = new URLSearchParams(location.search).get('join');
const joining = !!joinParam && onlineAvailable();
if (!joining && restoreState() === 'race') {
  refreshCands(); // вернуть кандидатов хода для восстановленной гонки
  scheduleAiMove(); // возобновить ходы ботов, если это была гонка с ними
}

updateUI();
resize(); // resize() сам вписывает восстановленную трассу/гонку в кадр (fit-to-content)

if (joining) {
  online.promptJoinByLink(joinParam!.toUpperCase());
} else if (onlineAvailable() && online.hasSavedSession()) {
  // Перезаход после дисконнекта: предложить вернуться в последнюю онлайн-игру.
  online.promptResume();
}

// Предложить установить игру ярлыком на телефон (Android/Chromium и iOS Safari).
initInstallPrompt();

// Зарегистрировать service worker: авто-обновление PWA с одной перезагрузкой.
initPwa();

// ─── Dev-only тест-хелперы (`window.__pr`) ─────────────────────────────────────
// Ручные хелперы для браузерной валидации живут в отдельном dev-only модуле
// `dev-helpers.ts` и подключаются динамическим импортом только под
// `import.meta.env.DEV`. В ПРОД-БАНДЛ НЕ ПОПАДАЮТ: Vite заменяет `import.meta.env.DEV`
// на `false`, ветка с импортом удаляется как мёртвый код, и чанк dev-helpers не
// создаётся — проверяется `npm run build` + grep по dist. Пользователю не видны.
if (import.meta.env.DEV) {
  void import('./dev-helpers').then(({ installDevHelpers }) =>
    installDevHelpers({
      S,
      canvas,
      startRace,
      refreshCands,
      updateUI,
      redraw,
      candOwner,
      cancelAiMove,
      commitMove,
      myTurn,
    }),
  );
}
