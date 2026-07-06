// Оркестрация: состояние приложения, переключение фаз редактор/гонка, сборка
// зависимостей ввода/онлайна/кнопок. Сами жесты указателя живут в input.ts.

import './ui/styles/index.css';
import { Track, finalizeTrack } from './model/track';
import { newEditor, stepBack, confirmEdges } from './model/editor';
import { GameState, Candidate, newGame, candidates, applyMove } from './model/game';
import { render, AppView } from './view/render';
import { Bounds, polylineBounds } from './view/camera';
import * as vp from './view/viewport';
import {
  bindButtons,
  updatePanel,
  showToast,
  setOnlineEnabled,
  PanelMode,
} from './ui/ui';
import { localizeDom } from './ui/localize';
import { strings } from './strings';
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
  const net = session.active() && game ? { yourTurn: myTurn() } : null;
  updatePanel(mode, editor, game, raceTrack?.startPoints.length ?? 6, net);
}

/** Может ли этот клиент ходить сейчас: в локальной игре — всегда, в онлайне — на своём месте. */
function myTurn(): boolean {
  if (!session.active()) return true;
  return game !== null && session.mySeat() === game.current;
}

/**
 * Применить выбранный ход: локально мутируем стейт, а в онлайне ещё и отправляем
 * его остальным. Не даём ходить не в свой ход / не в фазе гонки.
 */
function commitMove(cand: Candidate): void {
  if (!game || game.phase !== 'race' || !myTurn()) return;
  applyMove(game, cand);
  refreshCands();
  updateUI();
  redraw();
  if (session.active())
    session.pushMove(game).catch(() => showToast(strings.online.error));
}

function refreshCands(): void {
  input.clearSelection();
  if (
    game &&
    game.phase === 'race' &&
    game.players[game.current].skipTurns === 0 &&
    myTurn()
  ) {
    cands = candidates(game);
  } else {
    cands = null;
  }
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
  mode = onlineAvailable() ? 'mode' : 'players';
  updateUI();
  redraw();
}

/** Назад из шага настройки (режим/игроки): в редактор или к текущей гонке. */
function backFromSetup(): void {
  if (playersReturn === 'race') {
    mode = 'race';
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
  game = newGame(raceTrack, playerCount);
  mode = 'race';
  vp.fitToContent();
  refreshCands();
  updateUI();
  redraw();
}

/** Сбросить всё к чистому редактору (новая трасса / выход из онлайна). */
function resetToEdit(): void {
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
  setGame: (g) => {
    game = g;
  },
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
  },
  onChooseSameTrack: () => goToMode('race'),
  onPlayersBack: () => {
    // С экрана числа игроков назад — к выбору режима (если онлайн доступен) или
    // сразу в редактор/гонку (когда режимного шага не было).
    if (onlineAvailable()) {
      mode = 'mode';
      updateUI();
      redraw();
    } else {
      backFromSetup();
    }
  },
  onPlayerCount: (n) => startRace(n),
  onNewTrack: () => resetToEdit(),
  onModeLocal: () => {
    mode = 'players';
    updateUI();
    redraw();
  },
  onModeOnline: () => online.promptCreate(),
  onModeBack: () => backFromSetup(),
  onJoinByCode: () => online.promptJoin(),
  onLobbyStart: () => online.start(),
  onLobbyShare: () => online.share(),
  onLobbyCopyCode: () => online.copy(),
  onLobbyLeave: () => online.leave(),
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

// Открыта ссылка-приглашение (?join=CODE) — спросить имя и подключиться к игре.
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam && onlineAvailable()) {
  online.promptJoinByLink(joinParam.toUpperCase());
}

// Предложить установить игру ярлыком на телефон (Android/Chromium и iOS Safari).
initInstallPrompt();
