// Оркестрация: состояние приложения, переключение фаз редактор/гонка, сборка
// зависимостей ввода/онлайна/кнопок. Сами жесты указателя живут в input.ts.

import './ui/styles/index.css';
import { Track, finalizeTrack, clipFinishLine } from './model/track';
import { newEditor, stepBack, confirmEdges } from './model/editor';
import {
  GameState,
  Candidate,
  Rules,
  DEFAULT_RULES,
  normalizeRules,
  newGame,
  shuffledIndices,
  isFinished,
  WIN_CROSSINGS,
} from './model/game';
import { candidatesForSeat, applyMove, coastMove, retireSeat } from './model/turns';
import { Difficulty, chooseMove } from './model/ai';
import { NavField, buildNavField } from './model/nav';
import { strings } from './strings';
import { AI_MOVE_DELAY_MS } from './config';
import { render, AppView } from './view/render';
import { Bounds, polylineBounds, worldToScreen } from './view/camera';
import * as vp from './view/viewport';
import {
  bindButtons,
  updatePanel,
  setOnlineEnabled,
  setTurnCountdown,
  showConfirmMove,
  PanelMode,
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

let mode: PanelMode = 'edit';
let editor = newEditor();
/**
 * Готовая трасса, ожидающая выбора числа игроков (шаг «players»). Приходит либо
 * из редактора после выбора направления, либо из «Новая гонка → та же трасса».
 */
let raceTrack: Track | null = null;
/** Куда вернуться из шага выбора игроков по «Назад»: в редактор или в гонку. */
let playersReturn: 'edit' | 'race' = 'edit';
/**
 * Последний локальный состав (люди + боты + сложность) — чтобы «По той же трассе»
 * стартовала одним тапом, без повторного мастера выбора режима/игроков. Покрывает и
 * хотсит (bots 0), и игру против компьютера (humans 1). Онлайн сюда не попадает:
 * рематч с тем же составом участников — отдельная задача.
 */
let lastLocalRace: { humans: number; bots: number; difficulty: Difficulty } | null = null;
let game: GameState | null = null;
let cands: Candidate[] | null = null;
/**
 * Предвыбор хода («наметка»): кандидат, намеченный своим местом ещё в чужую очередь
 * (онлайн/vs-боты), ждущий ручного подтверждения «Газу!» в свой ход. Живёт здесь, а не
 * в input.selected (тот транзиентный и стирается каждым refreshCands). null — наметки нет.
 */
let pending: Candidate | null = null;
/** Правила заезда, выбранные в настройках (⚙). В онлайне их задаёт хост. */
let raceRules: Rules = { ...DEFAULT_RULES };
/**
 * Навигационное поле трассы текущей гонки (расстояния до финиша). Строится на
 * старте любой гонки: нужно и ботам (chooseMove), и полосе текущих мест
 * (renderStandings). null — вне гонки.
 */
let raceNav: NavField | null = null;
/** Таймер отложенного хода бота — гасится при любом выходе из гонки. */
let aiTimer: number | null = null;

/** Место за ботом (и какой сложности)? Бот-ность живёт в стейте (Player.bot). */
function isBotSeat(i: number): boolean {
  return !!game?.players[i]?.bot;
}

/** Bbox содержимого для fit/clamp: трасса гонки или редактируемая трасса.
 *  Провайдер границ для вьюпорта — «что сейчас на экране» знает приложение. */
function contentBounds(): Bounds | null {
  if (mode === 'race' && game) return polylineBounds(game.track.outer, game.track.inner);
  return polylineBounds(editor.outer, editor.inner, editor.center);
}

/** Пересчитать вьюпорт под новый размер поля и перерисовать. */
function resize(): void {
  vp.resize();
  redraw();
}

function redraw(): void {
  // Шаг выбора игроков рисуется как редактор: показываем готовую трассу-превью.
  const viewMode = mode === 'race' ? 'race' : 'edit';
  const app: AppView = {
    mode: viewMode,
    editor,
    game,
    cands,
    hover: input.getHover(),
    selected: input.getSelected(),
    pending,
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
  if (!game) return -1;
  let seat = -1;
  for (let i = 0; i < game.players.length; i++) {
    if (game.players[i].bot) continue;
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
  if (mode !== 'race' || !game || game.phase !== 'race') return -1;
  const seat = session.active() ? session.mySeat() : soloHumanSeat();
  if (seat < 0) return -1;
  const p = game.players[seat];
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
  if (!game || game.phase !== 'race') return -1;
  if (myTurn()) return game.players[game.current].skipTurns === 0 ? game.current : -1;
  return preselectSeat();
}

/**
 * Место локального игрока, который сдаётся кнопкой «Сдаться»: в онлайне — своё
 * место; локально — текущий ходящий, если это человек (на ходе бота сдаваться
 * некому — кнопка скрыта). −1, если гонки нет или сейчас ходит бот.
 */
function localHumanSeat(): number {
  if (!game) return -1;
  if (session.active()) return session.mySeat();
  return isBotSeat(game.current) ? -1 : game.current;
}

/** Доступна ли сейчас кнопка «Сдаться»: идёт гонка и локальный игрок ещё в ней
 *  (не финишировал и не сошёл). Сдаться можно в любой момент, не только в свой ход. */
function canRetire(): boolean {
  if (!game || mode !== 'race' || game.phase !== 'race') return false;
  const seat = localHumanSeat();
  return seat >= 0 && !isFinished(game.players[seat]) && !game.players[seat].retired;
}

function updateUI(): void {
  const net = online.netTurn(game);
  const aiTurn = !!game && isBotSeat(game.current);
  updatePanel(
    mode,
    editor,
    game,
    raceTrack?.startPoints.length ?? 6,
    net,
    aiTurn,
    canRetire(),
  );
  renderTurnQueue(mode === 'race' ? game : null);
  renderStandings(mode === 'race' ? game : null, raceNav);
}

/** Может ли этот клиент ходить сейчас: в локальной игре — всегда (кроме хода
 *  бота), в онлайне — на своём месте. */
function myTurn(): boolean {
  if (game && isBotSeat(game.current)) return false;
  if (!session.active()) return true;
  return game !== null && session.mySeat() === game.current;
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
  if (!game || game.phase !== 'race' || !isBotSeat(game.current)) return;
  aiTimer = window.setTimeout(() => {
    aiTimer = null;
    if (!game || game.phase !== 'race' || !isBotSeat(game.current) || !raceNav) return;
    const cand = chooseMove(game, raceNav, game.players[game.current].bot!);
    if (cand) applyMove(game, cand);
    else coastMove(game); // все кандидаты заняты соперниками — пас по инерции
    refreshCands();
    updateUI();
    redraw();
    scheduleAiMove();
  }, AI_MOVE_DELAY_MS);
}

/**
 * Применить выбранный ход: локально мутируем стейт, а в онлайне ещё и отправляем
 * его остальным. Не даём ходить не в свой ход / не в фазе гонки.
 */
function commitMove(cand: Candidate): void {
  if (!game || game.phase !== 'race' || !myTurn()) return;
  pending = null; // ход сделан — наметка отыграна
  if (session.active()) {
    // Онлайн: confirm-first — локальный стейт двинется только после успешной записи
    // (см. online.sendMove), чтобы при обрыве ход не потерялся и его можно было повторить.
    online.sendMove(cand);
    return;
  }
  applyMove(game, cand);
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove(); // в гонке с ботами после хода человека очередь едет к ботам
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
  retireSeat(game!, localHumanSeat());
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove(); // после выбытия человека очередь может уйти к ботам
}

function refreshCands(): void {
  input.clearSelection();
  const seat = candOwner();
  if (seat < 0) {
    cands = null;
    pending = null;
    return;
  }
  // В свой ход seat === game.current (обычная игра); в чужой ход (онлайн/vs-боты) —
  // своё место, чтобы наметить ход заранее.
  cands = candidatesForSeat(game!, seat);
  revalidatePending();
  // Курсор мог стоять на точке, пока прилетел чужой ход (предвыбор) — восстанавливаем
  // наведение по реальной позиции мыши, иначе clearSelection выше погасил бы его.
  input.reaimHover();
  // Наметка дожила до своего хода — вооружаем «Газу!», чтобы подтвердить одним тапом.
  if (myTurn() && pending) showConfirmMove(true);
}

/**
 * Проверить наметку против свежего состояния: если намеченная точка стала занята
 * соперником (встал в неё или на путь — blocked) либо аварийной, наметку сбрасываем
 * с тостом; иначе обновляем ссылку на актуальный кандидат. Зовётся из refreshCands —
 * единой воронки входящих состояний (onGameState в онлайне, цикл ботов локально).
 */
function revalidatePending(): void {
  if (!pending || !cands) return;
  const t = pending.target;
  const match = cands.find((c) => c.target.x === t.x && c.target.y === t.y);
  if (match && !match.blocked && !match.crash) {
    pending = match;
  } else {
    pending = null;
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
      editor.outer!,
      editor.inner!,
      editor.finish!,
      editor.forward!,
    );
    if ('error' in res) {
      editor.message = res.error;
      editor.error = true;
      updateUI();
      redraw();
      return;
    }
    raceTrack = res.track;
  } else {
    if (!game) return;
    raceTrack = game.track;
  }
  playersReturn = from;
  cancelAiMove(); // гонка с ботами на паузе, пока открыты экраны настройки
  mode = 'mode';
  updateUI();
  redraw();
}

/** Назад из шага настройки (режим/игроки): в редактор или к текущей гонке. */
function backFromSetup(): void {
  if (playersReturn === 'race') {
    mode = 'race';
    scheduleAiMove(); // вернулись в гонку с ботами — продолжить их ходы
  } else {
    mode = 'edit';
    stepBack(editor); // ready → direction
  }
  raceTrack = null;
  updateUI();
  redraw();
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
  if (!raceTrack) return;
  cancelAiMove();
  pending = null;
  game = newGame(raceTrack, humans + bots, raceRules, shuffledIndices(humans + bots));
  for (let i = humans; i < game.players.length; i++) {
    game.players[i].bot = difficulty;
    game.players[i].name = `${strings.aiSelect.botPrefix} ${game.players[i].name}`;
  }
  raceNav = buildNavField(raceTrack); // нужно ботам (chooseMove) и полосе мест
  lastLocalRace = { humans, bots, difficulty };
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove(); // если первым ходит бот — запустить цикл
}

/** Сбросить всё к чистому редактору (новая трасса / выход из онлайна). */
function resetToEdit(): void {
  // Если ещё в онлайн-сессии (например, финишировал, а другой игрок ещё гоняет,
  // и жмёшь «Новый заезд» → «Начертить новую») — выходим из неё, иначе прилетевший
  // ход соперника через onGameState реанимировал бы гонку и выдернул из редактора.
  if (session.active()) session.leave();
  cancelAiMove();
  game = null;
  raceNav = null;
  raceTrack = null;
  cands = null;
  pending = null;
  input.clearSelection();
  editor = newEditor();
  mode = 'edit';
  // Пустое поле → resize() покажет дефолтный вид (границ содержимого нет).
  updateUI();
  resize();
}

// Онлайн-флоу (host/join/start/leave/share) вынесен в online-controller.ts;
// он читает и мутирует состояние приложения через эти зависимости.
online.initOnline({
  getMode: () => mode,
  setMode: (m) => {
    mode = m;
  },
  getRaceTrack: () => raceTrack,
  setRaceTrack: (t) => {
    raceTrack = t;
  },
  getGame: () => game,
  setGame: (g) => {
    // Онлайн-гонка заменяет локальную: гасим локальный цикл ботов (в онлайне их ведёт
    // хост через online-controller). Бот-ность самих мест едет в стейте g (Player.bot).
    cancelAiMove();
    game = g;
    raceNav = g ? buildNavField(g.track) : null; // ботам (chooseMove) и полосе мест
    lastLocalRace = null; // онлайн-гонка — не локальный рематч, сбрасываем «ту же трассу»
  },
  getRules: () => raceRules,
  getNav: () => raceNav,
  setEditor: (e) => {
    editor = e;
  },
  fitToContent: () => vp.fitToContent(),
  refreshCands,
  updateUI,
  setTurnCountdown,
  redraw,
  resetToEdit,
});

// Жесты указателя и зум вынесены в input.ts; он читает состояние приложения и
// применяет ходы через эти зависимости, а подсветку (hover/selected/loupe) держит сам.
input.initInput({
  canvas,
  getMode: () => mode,
  getEditor: () => editor,
  getGame: () => game,
  getCands: () => cands,
  commitMove,
  // Предвыбор: сейчас не мой ход, но своё место может намечать (онлайн/vs-боты).
  isPreselect: () => !myTurn() && candOwner() >= 0,
  setPending: (cand) => {
    pending = cand;
    showConfirmMove(false); // не мой ход — кнопку не показываем, наметка видна на поле
    redraw();
  },
  goToMode,
  updateUI,
  redraw,
});

bindButtons({
  onBack: () => {
    stepBack(editor);
    updateUI();
    redraw();
  },
  onNext: () => {
    confirmEdges(editor);
    updateUI();
    redraw();
  },
  onConfirmMove: () => {
    const sel = input.getSelected();
    if (sel) commitMove(sel);
    // Свой ход с дожившей наметкой: «Газу!» коммитит её без повторного тапа.
    else if (pending && myTurn()) commitMove(pending);
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
    if (!game || !lastLocalRace) return;
    raceTrack = game.track;
    startRace(lastLocalRace.humans, lastLocalRace.bots, lastLocalRace.difficulty);
  },
  // «Та же трасса, другой режим»: сохранить трассу, заново выбрать режим/игроков.
  onSameTrackNewMode: () => goToMode('race'),
  canRematch: () => (!!game && !!lastLocalRace) || online.canRematch(),
  isOnline: () => session.active(),
  onPlayersBack: () => {
    // С экрана числа игроков назад — к выбору режима (он теперь есть всегда).
    mode = 'mode';
    updateUI();
    redraw();
  },
  onStartLocal: (humans, bots, difficulty) => startRace(humans, bots, difficulty),
  onOpenSettings: () =>
    openSettings(raceRules, false, (r) => {
      raceRules = r;
    }),
  onLobbySettings: () =>
    openSettings(raceRules, true, (r) => {
      raceRules = r;
    }),
  onNewTrack: () => resetToEdit(),
  onModeLocal: () => {
    mode = 'players';
    updateUI();
    redraw();
  },
  onModeOnline: () => online.promptCreate(),
  onModeAI: () => {
    mode = 'ai';
    updateUI();
    redraw();
  },
  onAiBack: () => {
    mode = 'mode';
    updateUI();
    redraw();
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
 * живёт на сервере) — вместо этого стираем прошлый локальный снимок.
 */
function saveState(): void {
  if (session.active()) {
    persist.clear();
    return;
  }
  persist.save({
    mode,
    editor,
    raceTrack,
    game,
    rules: raceRules,
    playersReturn,
    lastLocalRace,
  });
}

/** Восстановить локальное состояние из снимка. Возвращает восстановленный режим
 *  (или null, если снимка не было). */
function restoreState(): PanelMode | null {
  const snap = persist.load();
  if (!snap) return null;
  mode = snap.mode;
  editor = snap.editor;
  raceTrack = snap.raceTrack;
  game = snap.game;
  // Бэкфилл дефолтами: снимок мог быть записан старой версией без новых полей
  // правил (напр. turnLimitMs) — иначе они окажутся undefined. Так же чинит
  // серверные стейты net.ts при десериализации.
  raceRules = normalizeRules(snap.rules);
  playersReturn = snap.playersReturn;
  lastLocalRace = snap.lastLocalRace;
  // nav-поле не сериализуем — пересобираем из трассы (нужно ботам и полосе мест).
  // Бот-ность мест едет внутри game.players (Player.bot) — отдельно не восстанавливаем.
  if (game) raceNav = buildNavField(game.track);
  return snap.mode;
}

// Мобильный swipe-to-reload, жест/кнопка «назад», закрытие или сворачивание вкладки:
// pagehide ловит выгрузку и уход в bfcache, visibilitychange — сворачивание (на
// телефоне самое надёжное, вкладку могут выгрузить из фона без pagehide).
window.addEventListener('pagehide', saveState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
});

// Заполнить статичные тексты разметки из strings до первого показа панели.
localizeDom();

// Метка сборки внизу шторки «Правила» — честный признак, какой код сейчас крутится
// (строка вкомпилирована в бандл): коммит + время сборки. Время форматируем в
// локальный час, чтобы «только что» совпадало с настенным временем.
const buildLabel = new Date(__BUILD_TIME__).toLocaleString('ru-RU', {
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
// Ручное прохождение мастера редактора (нарисовать петлю → кромки → финиш →
// направление → режим → игроки) при браузерной валидации сжигает уйму шагов и
// токенов. Эти хелперы прыгают сразу в нужное состояние на готовой трассе и
// возвращают дешёвый JSON-снимок — читать состояние можно одним вызовом вместо
// цепочки скриншотов. В ПРОД-БАНДЛ НЕ ПОПАДАЮТ: Vite заменяет `import.meta.env.DEV`
// на `false`, и вся ветка (вместе с трассой-фикстурой) удаляется как мёртвый код —
// проверяется `npm run build` + grep по dist. Пользователю не видны.
if (import.meta.env.DEV) {
  // Готовая прямоугольная трасса-«бублик»: дорога — рамка между внешним и
  // внутренним прямоугольниками, финиш поперёк НИЖНЕЙ прямой, гонка в +x.
  // Финиш строится так же, как в редакторе, — коротким штрихом поперёк дороги,
  // обрезанным по кромкам через `clipFinishLine` (концы вынесены за кромки на
  // 0.25). Так фикстура остаётся реально рисуемой мастером: линия пересекает всю
  // ширину дороги от кромки до кромки (y=0 внешняя → y=8 внутренняя), а не
  // обрывается посередине, как раньше на ЛЕВОЙ прямой (x=6, где дорога тянется
  // до y=24, а линия доходила лишь до y=8).
  const devTrack = (): Track => {
    const outer = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 24 },
      { x: 0, y: 24 },
    ];
    const inner = [
      { x: 8, y: 8 },
      { x: 32, y: 8 },
      { x: 32, y: 16 },
      { x: 8, y: 16 },
    ];
    const fin = clipFinishLine({ x: 20, y: 3 }, { x: 20, y: 5 }, outer, inner);
    if ('error' in fin) throw new Error(`dev finish invalid: ${fin.error}`);
    const res = finalizeTrack(outer, inner, fin.finish, { x: 1, y: 0 });
    if ('error' in res) throw new Error(`dev track invalid: ${res.error}`);
    return res.track;
  };
  // Дешёвый снимок ключевого состояния для ассертов без скриншотов.
  const snap = () => ({
    mode,
    phase: game?.phase ?? null,
    current: game?.current ?? null,
    players:
      game?.players.map((p) => ({
        name: p.name,
        bot: p.bot ?? null,
        place: p.place,
        pos: p.pos,
        vel: p.vel,
        crossings: p.crossings,
        finished: isFinished(p),
      })) ?? null,
    lastLocalRace,
    // Предвыбор: место-владелец веера, число кандидатов и текущая наметка.
    candSeat: candOwner(),
    candsCount: cands?.length ?? null,
    pending: pending?.target ?? null,
    hover: input.getHover()?.target ?? null,
  });
  (window as unknown as Record<string, unknown>).__pr = {
    /** Готовая трасса + сразу локальная гонка: humans людей, bots ботов. */
    race(humans = 1, bots = 1, difficulty: Difficulty = 'medium') {
      raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      return snap();
    },
    /** Живая гонка, придвинутая к финишу: всем (людям и ботам) выставляется
     *  crossings = WIN−laps, позиции не трогаем (болиды остаются на стартовой
     *  решётке за линией). При laps=1 первое же пересечение финиша побеждает —
     *  удобно доиграть концовку вручную (расстановка мест, заморозка порядка,
     *  переход в phase='over', win-экран), не наматывая круги. */
    nearFinish(humans = 1, bots = 1, laps = 1, difficulty: Difficulty = 'medium') {
      raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      for (const p of game!.players) p.crossings = WIN_CROSSINGS - laps;
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** Гонка, где человек (seat 0) в одном ходе от победы: crossings = WIN−1, стоит
     *  на нижней прямой перед линией финиша (x=20) с инерцией (2,0) сквозь неё
     *  (18→20); соперники убраны на верхнюю прямую, чтобы не мешать и не
     *  финишировать. После tapAccel(0,0) человек побеждает, но place ещё null (идёт
     *  доигровка раунда) — это и есть «окно финиша», в котором финишёру НЕ должен
     *  предлагаться ход. */
    raceAtWin(bots = 1, difficulty: Difficulty = 'medium') {
      raceTrack = devTrack();
      startRace(1, bots, difficulty);
      const h = game!.players[0];
      h.crossings = WIN_CROSSINGS - 1;
      h.pos = { x: 18, y: 4 };
      h.vel = { x: 2, y: 0 };
      for (let i = 1; i < game!.players.length; i++) {
        game!.players[i].pos = { x: 16, y: 20 }; // верхняя прямая, не блокируют финиш
      }
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** Готовая трасса → экран выбора режима (минуя рисование). */
    toMode() {
      raceTrack = devTrack();
      playersReturn = 'edit';
      cancelAiMove();
      mode = 'mode';
      updateUI();
      redraw();
      return snap();
    },
    /** Обнулить сохранённый локальный состав (эмуляция «после онлайн-гонки»,
     *  когда рематч одним тапом недоступен и кнопка «Рематч» прячется). */
    clearLastRace() {
      lastLocalRace = null;
      updateUI();
      return snap();
    },
    /** Снимок состояния приложения для ассертов. */
    state: snap,
    /**
     * Тап по кандидату с ускорением (ax, ay) у места-владельца веера — тем же
     * решением, что input.endGesture: в чужой ход это наметка (setPending), в свой —
     * коммит. Позволяет прогнать предвыбор без синтетики pointer-событий по canvas.
     */
    tapAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0 || !cands) return snap();
      const p = game!.players[seat];
      const tx = p.pos.x + p.vel.x + ax;
      const ty = p.pos.y + p.vel.y + ay;
      const c = cands.find((k) => k.target.x === tx && k.target.y === ty);
      if (!c) return snap();
      if (!myTurn() && seat >= 0) {
        pending = c; // наметка (как setPending в input-deps)
        redraw();
      } else {
        commitMove(c);
      }
      return snap();
    },
    /** Подтвердить наметку в свой ход (эквивалент кнопки «Газу!»). */
    confirm() {
      if (pending && myTurn()) commitMove(pending);
      return snap();
    },
    /** Синтетический ховер мышью над кандидатом с ускорением (ax, ay) — проверить,
     *  что наведение переживает чужой ход (reaimHover). */
    hoverAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0) return snap();
      const p = game!.players[seat];
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      const scr = worldToScreen(vp.camera(), target);
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'mouse',
          clientX: r.left + scr.x,
          clientY: r.top + scr.y,
          bubbles: true,
        }),
      );
      return snap();
    },
    /** Прогнать refreshCands+redraw — эмуляция входящего чужого хода без смены стейта. */
    refresh() {
      refreshCands();
      redraw();
      return snap();
    },
  };
}
