// Онлайн-флоу поверх online.ts: хост/вход/старт/выход/шаринг + обработчики
// realtime-событий сессии. Всё «сетевое взаимодействие с UI» вынесено из main.ts.
// Контроллер не владеет состоянием приложения (game/mode/raceTrack/editor) —
// читает и мутирует его через переданный на init OnlineDeps, а перерисовку и
// пересчёт делает его же колбэками. Ровно один контроллер на приложение.

import { Track } from './track';
import { GameState, newGame, seatColor } from './game';
import { EditorState, editorFromTrack } from './editor';
import {
  renderLobby,
  openNameDialog,
  openJoinDialog,
  showJoinError,
  showToast,
  closeOverlay,
  PanelMode,
} from './ui';
import { strings } from './strings';
import * as session from './online';
import { OnlineHandlers } from './online';

/** Мост к состоянию и флоу главного модуля: контроллер не держит их сам. */
export interface OnlineDeps {
  getMode(): PanelMode;
  setMode(m: PanelMode): void;
  getRaceTrack(): Track | null;
  setRaceTrack(t: Track | null): void;
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
  },
  onClosed: () => {
    showToast(strings.online.closed);
    deps.resetToEdit();
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

/** Открыта ссылка-приглашение (?join=CODE): спросить имя и подключиться. */
export function promptJoinByLink(code: string): void {
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
