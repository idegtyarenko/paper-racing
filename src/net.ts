// Сетевой слой онлайн-режима: клиент Supabase, сериализация трассы/стейта и
// операции над строкой игры. DOM здесь нет — только транспорт и (де)сериализация.
//
// Модель «общий стейт, ходит — пишет»: активный игрок применяет ход локально и
// пишет строку игры; остальные подхватывают изменения через realtime-подписку.

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { Vec } from './geometry';
import { Track, WORLD_W, WORLD_H, setWorldSize } from './track';
import { GameState } from './game';

// ── Сериализация ────────────────────────────────────────────────────────────────

/** Трасса в JSON-виде: Set `inside` → массив, плюс размеры мира хоста. */
export interface SerializedTrack {
  outer: Vec[];
  inner: Vec[];
  finish: { a: Vec; b: Vec };
  forward: Vec;
  inside: number[];
  startPoints: Vec[];
  worldW: number;
  worldH: number;
}

/** Стейт гонки без поля `track` (трасса хранится в строке отдельно и неизменна). */
export type SerializedState = Omit<GameState, 'track'>;

export interface RosterEntry {
  clientId: string;
  name: string;
}

export interface GameRow {
  id: string;
  track: SerializedTrack;
  state: SerializedState | null;
  lobby: RosterEntry[];
  host_id: string;
  status: 'lobby' | 'race' | 'over';
}

export function serializeTrack(t: Track): SerializedTrack {
  return {
    outer: t.outer,
    inner: t.inner,
    finish: t.finish,
    forward: t.forward,
    inside: [...t.inside],
    startPoints: t.startPoints,
    worldW: WORLD_W,
    worldH: WORLD_H,
  };
}

/**
 * Восстанавливает трассу и — важно для гостя — выставляет размеры мира хоста, чтобы
 * рендер совпадал (вызывающий должен зафиксировать мир и вписать сетку).
 */
export function deserializeTrack(s: SerializedTrack): Track {
  setWorldSize(s.worldW, s.worldH);
  return {
    outer: s.outer,
    inner: s.inner,
    finish: s.finish,
    forward: s.forward,
    inside: new Set(s.inside),
    startPoints: s.startPoints,
  };
}

export function serializeState(g: GameState): SerializedState {
  const { track: _track, ...rest } = g;
  return rest;
}

export function deserializeState(s: SerializedState, track: Track): GameState {
  return { ...s, track };
}

// ── Идентичность и код игры ──────────────────────────────────────────────────────

const CLIENT_ID_KEY = 'pr-client-id';

/** Стабильный id этого браузера — переживает перезагрузку (нужен для места в лобби). */
export function clientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// Алфавит без похожих символов (0/O, 1/I) — код проще диктовать и вводить.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode(len = 5): string {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[a[i] % CODE_ALPHABET.length];
  return s;
}

// ── Клиент Supabase ──────────────────────────────────────────────────────────────

let client: SupabaseClient | null = null;

/** Настроен ли онлайн-режим (заданы env-переменные Supabase). */
export function onlineAvailable(): boolean {
  return !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

function db(): SupabaseClient {
  if (!client) {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !key) throw new Error('supabase-not-configured');
    client = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
  }
  return client;
}

// ── Операции ─────────────────────────────────────────────────────────────────────

/** Создать игру: вставляет строку с трассой и хостом в лобби. Возвращает строку. */
export async function createGame(track: Track, hostName: string): Promise<GameRow> {
  const id = makeCode();
  const me = clientId();
  const row = {
    id,
    track: serializeTrack(track),
    state: null,
    lobby: [{ clientId: me, name: hostName }],
    host_id: me,
    status: 'lobby' as const,
  };
  const { data, error } = await db().from('games').insert(row).select().single();
  if (error) {
    // Крайне редкая коллизия кода — одна повторная попытка с новым кодом.
    if (error.code === '23505') return createGame(track, hostName);
    throw error;
  }
  return data as GameRow;
}

/** Присоединиться к игре по коду (атомарно через RPC). Возвращает строку игры. */
export async function joinGame(code: string, name: string): Promise<GameRow> {
  const { data, error } = await db().rpc('join_game', {
    p_code: code,
    p_client_id: clientId(),
    p_name: name,
  });
  if (error) throw error;
  return data as GameRow;
}

/** Прочитать строку игры по коду (null — если не найдена). */
export async function fetchGame(code: string): Promise<GameRow | null> {
  const { data, error } = await db().from('games').select().eq('id', code).maybeSingle();
  if (error) throw error;
  return (data as GameRow) ?? null;
}

/** Записать текущий стейт гонки (после хода или при старте). Обновляет status. */
export async function pushState(code: string, state: GameState): Promise<void> {
  const status = state.phase === 'over' ? 'over' : 'race';
  const { error } = await db()
    .from('games')
    .update({
      state: serializeState(state),
      status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', code);
  if (error) throw error;
}

/** Выйти из лобби (атомарно): освобождает место, при опустошении/выходе хоста удаляет игру. */
export async function leaveGame(code: string): Promise<void> {
  await db().rpc('leave_game', { p_code: code, p_client_id: clientId() });
}

/**
 * Подписаться на изменения строки игры. onChange получает новую строку при
 * INSERT/UPDATE и null при удалении игры (DELETE — TTL/хост вышел).
 */
export function subscribeGame(
  code: string,
  onChange: (row: GameRow | null) => void,
): RealtimeChannel {
  return db()
    .channel(`game:${code}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'games', filter: `id=eq.${code}` },
      (payload) => {
        if (payload.eventType === 'DELETE') onChange(null);
        else onChange(payload.new as GameRow);
      },
    )
    .subscribe();
}

export function unsubscribe(ch: RealtimeChannel): void {
  db().removeChannel(ch);
}
