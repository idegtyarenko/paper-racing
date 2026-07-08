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
  fetchGame,
  joinGame,
  leaveGame,
  pruneSeat,
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
  /** Изменилось присутствие (кто-то онлайн/офлайн) — пересчитать таймер/пропуск/метки. */
  onPresence: () => void;
  /** Состояние realtime-канала изменилось — показать/спрятать баннер соединения. */
  onConnection: (connected: boolean) => void;
}

let code: string | null = null;
let channel: RealtimeChannel | null = null;
let roster: RosterEntry[] = [];
let hostFlag = false;
let track: Track | null = null;
let handlers: OnlineHandlers | null = null;
/** clientId'ы, чьи вкладки сейчас онлайн (Realtime Presence). */
let present = new Set<string>();
/** Когда clientId пропал из присутствия (мс) — метка 30-секундной форы на авто-пропуск. */
let leftAt = new Map<string, number>();
/** Есть ли сейчас связь по realtime-каналу (для баннера «нет связи»). */
let connected = true;

/** Идёт ли онлайн-сессия (создана или подключена игра). */
export function active(): boolean {
  return code !== null;
}

/** Есть ли сейчас связь по realtime-каналу. */
export function isConnected(): boolean {
  return connected;
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

/** clientId места по индексу ростера (null — места нет). */
function seatClientId(seat: number): string | null {
  return roster[seat]?.clientId ?? null;
}

/** Онлайн ли вкладка игрока на этом месте прямо сейчас. */
export function isPresent(seat: number): boolean {
  const id = seatClientId(seat);
  return id !== null && present.has(id);
}

/** Когда игрок этого места пропал из присутствия (мс), либо null — если он онлайн. */
export function leftAtOf(seat: number): number | null {
  const id = seatClientId(seat);
  if (id === null || present.has(id)) return null;
  return leftAt.get(id) ?? null;
}

/**
 * Место присутствующего клиента, назначенного выполнять авто-пропуск/прунинг —
 * минимальный онлайн-seat. Так дублирующую запись делает только один клиент
 * (остальные пишут идентичный стейт, но лишний трафик ни к чему). −1 — никого нет.
 */
export function designatedSkipper(): number {
  for (let s = 0; s < roster.length; s++) if (isPresent(s)) return s;
  return -1;
}

/** Обработать sync присутствия: обновить набор онлайн и метки ухода, дёрнуть handler. */
function handlePresence(next: Set<string>): void {
  present.forEach((id) => {
    if (!next.has(id)) leftAt.set(id, Date.now());
  });
  next.forEach((id) => leftAt.delete(id));
  present = next;
  handlers?.onPresence();
}

/**
 * Обработать смену состояния realtime-канала. При (пере)подключении — ресинк:
 * тянем актуальную строку игры (закрывает пропущенные за время обрыва апдейты и
 * щель между начальным fetch и выходом подписки в онлайн). Удалённую за это время
 * игру fetchGame вернёт как null → applyRow(null) → штатный onClosed. Баннер
 * дёргаем только при реальной смене состояния.
 */
function handleStatus(ok: boolean): void {
  if (!code) return; // после close() события мёртвого канала инертны
  if (ok)
    fetchGame(code)
      .then(applyRow)
      .catch(() => {});
  if (connected !== ok) {
    connected = ok;
    handlers?.onConnection(ok);
  }
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
  connected = true;
  channel = subscribeGame(code, applyRow, handlePresence, handleStatus);
  applyRow(row);
  return code;
}

/**
 * Имя, под которым этот клиент уже записан в ростере игры с данным кодом
 * (то есть повторный вход в уже активную игру), либо null — если игры нет
 * или клиента в её ростере нет. Позволяет не переспрашивать имя при реконнекте.
 */
export async function memberName(joinCode: string): Promise<string | null> {
  try {
    const row = await fetchGame(joinCode);
    const me = row?.lobby?.find((r) => r.clientId === clientId());
    return me?.name ?? null;
  } catch {
    return null;
  }
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
  connected = true;
  channel = subscribeGame(code, applyRow, handlePresence, handleStatus);
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

/** Убрать из лобби брошенное место (по индексу) — прунинг присутствующим клиентом. */
export async function prune(seat: number): Promise<void> {
  const id = seatClientId(seat);
  if (code && id) await pruneSeat(code, id);
}

/** Снять своё присутствие немедленно (при закрытии вкладки) — best-effort. */
export function untrack(): void {
  channel?.untrack();
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
  // Сначала зануляем code/handlers, потом отписываемся: прилетевший из-за
  // removeChannel статус CLOSED пройдёт через handleStatus как no-op (нет code).
  const ch = channel;
  channel = null;
  code = null;
  handlers = null;
  roster = [];
  hostFlag = false;
  track = null;
  present = new Set();
  leftAt = new Map();
  connected = true;
  if (ch) unsubscribe(ch);
}
