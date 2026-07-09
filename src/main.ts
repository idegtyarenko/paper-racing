// Оркестрация: состояние приложения, переключение фаз редактор/гонка, сборка
// зависимостей ввода/онлайна/кнопок. Сами жесты указателя живут в input.ts.

import './ui/styles/index.css';
import { Track, finalizeTrack } from './model/track';
import { newEditor, stepBack, confirmEdges } from './model/editor';
import {
  GameState,
  Candidate,
  Rules,
  DEFAULT_RULES,
  MAX_PLAYERS,
  newGame,
} from './model/game';
import { candidates, applyMove, coastMove } from './model/turns';
import { NavField, Difficulty, buildNavField, chooseMove } from './model/ai';
import { strings } from './strings';
import { AI_MOVE_DELAY_MS } from './config';
import { render, AppView } from './view/render';
import { Bounds, polylineBounds } from './view/camera';
import * as vp from './view/viewport';
import { bindButtons, updatePanel, setOnlineEnabled, PanelMode } from './ui/panel';
import { renderTurnQueue } from './ui/turn-queue';
import { openSettings } from './ui/settings';
import { localizeDom } from './ui/localize';
import { onlineAvailable } from './online/net';
import * as session from './online/online';
import * as online from './online/online-controller';
import * as input from './view/input';
import { initInstallPrompt } from './ui/install-prompt';

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
let game: GameState | null = null;
let cands: Candidate[] | null = null;
/** Правила заезда, выбранные в настройках (⚙). В онлайне их задаёт хост. */
let raceRules: Rules = { ...DEFAULT_RULES };
/** Гонка против компьютера: какие места за ботами (index = seat), null — ботов нет. */
let aiSeats: boolean[] | null = null;
/** Навигационное поле ботов для текущей трассы (строится на старте AI-гонки). */
let aiNav: NavField | null = null;
let aiDifficulty: Difficulty = 'medium';
/** Таймер отложенного хода бота — гасится при любом выходе из гонки. */
let aiTimer: number | null = null;

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
    loupe: input.getLoupe(),
    cam: vp.camera(),
  };
  render(ctx, app);
}

function updateUI(): void {
  const net = online.netTurn(game);
  const aiTurn = !!(game && aiSeats?.[game.current]);
  updatePanel(mode, editor, game, raceTrack?.startPoints.length ?? 6, net, aiTurn);
  renderTurnQueue(mode === 'race' ? game : null);
}

/** Может ли этот клиент ходить сейчас: в локальной игре — всегда (кроме хода
 *  бота), в онлайне — на своём месте. */
function myTurn(): boolean {
  if (game && aiSeats?.[game.current]) return false;
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
 * Цикл ходов ботов: если сейчас очередь бота, походить им после короткой паузы
 * (человек успевает следить) и продолжить, пока очередь не вернётся к человеку
 * или гонка не кончится. Пауза сбрасывается при выходе из гонки (cancelAiMove).
 */
function scheduleAiMove(): void {
  if (aiTimer !== null) return;
  if (!game || game.phase !== 'race' || !aiSeats?.[game.current]) return;
  aiTimer = window.setTimeout(() => {
    aiTimer = null;
    if (!game || game.phase !== 'race' || !aiSeats?.[game.current] || !aiNav) return;
    const cand = chooseMove(game, aiNav, aiDifficulty);
    if (cand) applyMove(game, cand);
    else coastMove(game); // все кандидаты заняты соперниками — пас по инерции
    refreshCands();
    updateUI();
    redraw();
    scheduleAiMove();
  }, AI_MOVE_DELAY_MS);
}

/** Выйти из режима игры с ботами (новая настройка гонки / выход в редактор). */
function clearAi(): void {
  cancelAiMove();
  aiSeats = null;
  aiNav = null;
}

/**
 * Применить выбранный ход: локально мутируем стейт, а в онлайне ещё и отправляем
 * его остальным. Не даём ходить не в свой ход / не в фазе гонки.
 */
function commitMove(cand: Candidate): void {
  if (!game || game.phase !== 'race' || !myTurn()) return;
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

function refreshCands(): void {
  input.clearSelection();
  if (
    !game ||
    game.phase !== 'race' ||
    game.players[game.current].skipTurns !== 0 ||
    !myTurn()
  ) {
    cands = null;
    return;
  }
  cands = candidates(game);
}

/**
 * Перейти к шагу выбора режима игры. Из редактора («edit») сначала финализируем
 * нарисованную трассу; если не удалось — показываем ошибку и остаёмся в редакторе.
 * Из гонки («race», «та же трасса») берём готовую трассу текущей гонки. Если онлайн
 * не настроен — сразу к выбору числа игроков (только локальная игра).
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

/** Выбрано число игроков — стартуем локальную гонку на подготовленной трассе. */
function startRace(playerCount: number): void {
  if (!raceTrack) return;
  clearAi();
  game = newGame(raceTrack, playerCount, raceRules);
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
}

/**
 * Выбрана сложность — стартуем гонку против компьютера: человек на месте 0
 * («Красный», поул — стартовая клетка ближе всех к линии), остальные места
 * (до пяти, сколько влезает на стартовую решётку) за ботами.
 */
function startAiRace(difficulty: Difficulty): void {
  if (!raceTrack) return;
  clearAi();
  game = newGame(raceTrack, MAX_PLAYERS, raceRules);
  aiSeats = game.players.map((_, i) => i !== 0);
  game.players.forEach((p, i) => {
    if (aiSeats![i]) p.name = `${strings.aiSelect.botPrefix} ${p.name}`;
  });
  aiNav = buildNavField(raceTrack);
  aiDifficulty = difficulty;
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
  scheduleAiMove();
}

/** Сбросить всё к чистому редактору (новая трасса / выход из онлайна). */
function resetToEdit(): void {
  clearAi();
  game = null;
  raceTrack = null;
  cands = null;
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
    clearAi(); // онлайн-гонка заменяет локальную — боты в ней не участвуют
    game = g;
  },
  getRules: () => raceRules,
  setEditor: (e) => {
    editor = e;
  },
  fitToContent: () => vp.fitToContent(),
  refreshCands,
  updateUI,
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
    else online.retryMove(); // десктоп: выделение не хранится — повторяем последний ход
  },
  onChooseSameTrack: () => goToMode('race'),
  onPlayersBack: () => {
    // С экрана числа игроков назад — к выбору режима (он теперь есть всегда).
    mode = 'mode';
    updateUI();
    redraw();
  },
  onPlayerCount: (n) => startRace(n),
  onOpenSettings: () =>
    openSettings(raceRules, (r) => {
      raceRules = r;
    }),
  onLobbySettings: () =>
    openSettings(raceRules, (r) => {
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
  onAiDifficulty: (d) => startAiRace(d),
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
  onLobbyLeave: () => online.leave(),
  onSkip: () => online.skip(),
});

// Заполнить статичные тексты разметки из strings до первого показа панели.
localizeDom();

// Онлайн-входы показываем только если бэкенд настроен (иначе — только локальная игра).
setOnlineEnabled(onlineAvailable());

// Камера: связать вьюпорт с canvas/обёрткой и провайдером границ содержимого.
vp.initViewport(canvas, wrap, contentBounds);

// ResizeObserver вместо window.resize: обёртка меняет размер и при смене
// раскладки (портрет/ландшафт на мобильных), а не только окна.
new ResizeObserver(resize).observe(wrap);
updateUI();
resize();

// Открыта ссылка-приглашение (?join=CODE) — подключиться к игре (при повторном
// входе имя уже известно, иначе спросим).
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam && onlineAvailable()) {
  online.promptJoinByLink(joinParam.toUpperCase());
}

// Предложить установить игру ярлыком на телефон (Android/Chromium и iOS Safari).
initInstallPrompt();
