// Онлайн-сессия: тонкий слой поверх net.ts, хранящий состояние текущей игры
// (код, ростер, роль хоста, трасса) и переводящий входящие строки из realtime в
// высокоуровневые события для main.ts. Ровно одна активная сессия за раз.

import { RealtimeChannel } from '@supabase/supabase-js';
import { Track } from '../model/track';
import { GameState } from '../model/game';
import {
  GameRow,
  RosterEntry,
  clientId,
  createGame,
  joinGame,
  leaveGame,
  pushState,
  subscribeGame,
  unsubscribe,
  deserializeTrack,
  deserializeState,
} from './net';

export interface OnlineHandlers {
  /** Ростер/статус лобби изменился (кто-то вошёл/вышел) — обновить экран лобби. */
  onLobby: () => void;
  /** Пришёл стейт гонки (старт или чужой ход) — заменить локальную игру и перерисовать. */
  onGameState: (game: GameState) => void;
  /** Игра удалена на сервере (TTL / хост вышел) — вернуться из онлайна. */
  onClosed: () => void;
}

let code: string | null = null;
let channel: RealtimeChannel | null = null;
let roster: RosterEntry[] = [];
let hostFlag = false;
let track: Track | null = null;
let handlers: OnlineHandlers | null = null;

/** Идёт ли онлайн-сессия (создана или подключена игра). */
export function active(): boolean {
  return code !== null;
}

export function getCode(): string | null {
  return code;
}

export function getRoster(): RosterEntry[] {
  return roster;
}

export function isHost(): boolean {
  return hostFlag;
}

export function getTrack(): Track | null {
  return track;
}

/** Место (индекс) этого клиента в ростере; −1 — если не за столом. */
export function mySeat(): number {
  return roster.findIndex((r) => r.clientId === clientId());
}

/** Хост может стартовать, когда подключился хотя бы ещё один игрок. */
export function canStart(): boolean {
  return hostFlag && roster.length >= 2;
}

/** Обработать входящую строку игры (из realtime или начальную). */
function applyRow(row: GameRow | null): void {
  if (!row) {
    close();
    handlers?.onClosed();
    return;
  }
  roster = row.lobby ?? [];
  if (row.state && track) {
    handlers?.onGameState(deserializeState(row.state, track));
  } else {
    handlers?.onLobby();
  }
}

/** Создать игру (хост). Возвращает код игры. */
export async function host(t: Track, name: string, h: OnlineHandlers): Promise<string> {
  const row = await createGame(t, name);
  handlers = h;
  code = row.id;
  hostFlag = true;
  track = t;
  channel = subscribeGame(code, applyRow);
  applyRow(row);
  return code;
}

/** Присоединиться к игре по коду (гость). */
export async function join(
  joinCode: string,
  name: string,
  h: OnlineHandlers,
): Promise<void> {
  const row = await joinGame(joinCode, name);
  handlers = h;
  code = row.id;
  hostFlag = row.host_id === clientId();
  track = deserializeTrack(row.track);
  channel = subscribeGame(code, applyRow);
  applyRow(row);
}

/** Стартовать гонку (хост): записать первый стейт. */
export async function start(game: GameState): Promise<void> {
  if (code) await pushState(code, game);
}

/** Отправить свой ход остальным. */
export async function pushMove(game: GameState): Promise<void> {
  if (code) await pushState(code, game);
}

/** Выйти из сессии: освободить место на сервере и отписаться. */
export async function leave(): Promise<void> {
  const c = code;
  close();
  if (c) {
    try {
      await leaveGame(c);
    } catch {
      // Выход — best-effort: даже при ошибке сети локально уже вышли.
    }
  }
}

/** Локально закрыть сессию (отписка + сброс состояния). */
function close(): void {
  if (channel) unsubscribe(channel);
  channel = null;
  code = null;
  roster = [];
  hostFlag = false;
  track = null;
  handlers = null;
}
