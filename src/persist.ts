// Сохранение локального стейта игры в localStorage, чтобы перезагрузка страницы
// (swipe-to-reload, кнопка/жест «назад», сворачивание вкладки на телефоне) не
// сбрасывала игру к первому экрану рисования трассы. Онлайн сюда не попадает —
// его сессия живёт на сервере и восстанавливается своим путём.

import { PanelMode } from './ui/panel';
import { EditorState } from './model/editor';
import { Track } from './model/track';
import { GameState, Rules } from './model/game';
import { Difficulty } from './model/ai';
import {
  SerializedTrack,
  SerializedState,
  serializeTrack,
  deserializeTrack,
  serializeState,
  deserializeState,
} from './online/net';

const KEY = 'pr-local-state';
// v2: у игроков появились place/retired, у стейта — roundFinishers (гонка идёт
// до финиша всех). Старые снимки без этих полей несовместимы — их отбрасываем.
const VERSION = 2;

/** Последний локальный режим/состав — для «По той же трассе» одним тапом. */
export type LastLocalRace =
  { mode: 'local'; count: number } | { mode: 'ai'; difficulty: Difficulty };

/** Живой снимок локального состояния приложения (то, что держит main.ts). */
export interface LocalSnapshot {
  mode: PanelMode;
  editor: EditorState;
  raceTrack: Track | null;
  game: GameState | null;
  rules: Rules;
  playersReturn: 'edit' | 'race';
  lastLocalRace: LastLocalRace | null;
  /** Гонка с ботами: места ботов и сложность (nav-поле пересобирается из трассы). */
  ai: { seats: boolean[]; difficulty: Difficulty } | null;
}

/** JSON-форма снимка: трассы с Set `inside` разворачиваются в массивы. */
interface Stored {
  v: number;
  mode: PanelMode;
  editor: EditorState;
  raceTrack: SerializedTrack | null;
  game: { track: SerializedTrack; state: SerializedState } | null;
  rules: Rules;
  playersReturn: 'edit' | 'race';
  lastLocalRace: LastLocalRace | null;
  ai: { seats: boolean[]; difficulty: Difficulty } | null;
}

/** Записать снимок. Ошибку записи (квота/приватный режим) молча глотаем. */
export function save(snap: LocalSnapshot): void {
  try {
    const stored: Stored = {
      v: VERSION,
      mode: snap.mode,
      editor: snap.editor,
      raceTrack: snap.raceTrack ? serializeTrack(snap.raceTrack) : null,
      game: snap.game
        ? { track: serializeTrack(snap.game.track), state: serializeState(snap.game) }
        : null,
      rules: snap.rules,
      playersReturn: snap.playersReturn,
      lastLocalRace: snap.lastLocalRace,
      ai: snap.ai,
    };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // localStorage недоступен или переполнен — просто не сохраняем.
  }
}

/** Стереть сохранённый снимок (выход в онлайн / повреждённые данные). */
export function clear(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // недоступен — ничего страшного.
  }
}

/** Прочитать и восстановить снимок; null — если его нет или он несовместим. */
export function load(): LocalSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Stored;
    if (s.v !== VERSION) return null;
    // Онлайн-лобби локально не восстанавливается — снимок такого режима игнорируем.
    if (s.mode === 'lobby') return null;
    // Доигранную гонку не восстанавливаем: возвращаться на экран победителя незачем,
    // после перезагрузки честнее начать с чистого редактора (снимок игнорируем).
    if (s.game?.state.phase === 'over') return null;
    const editor = sanitizeEditor(s.editor);
    const raceTrack = s.raceTrack ? deserializeTrack(s.raceTrack) : null;
    const game = s.game
      ? deserializeState(s.game.state, deserializeTrack(s.game.track))
      : null;
    return {
      mode: s.mode,
      editor,
      raceTrack,
      game,
      rules: s.rules,
      playersReturn: s.playersReturn ?? 'edit',
      lastLocalRace: s.lastLocalRace ?? null,
      ai: game && s.ai ? s.ai : null,
    };
  } catch {
    return null;
  }
}

/**
 * Сбросить незавершённый жест редактора: снимок мог быть сделан прямо во время
 * рисования штриха или перетаскивания кромки (сворачивание вкладки посреди
 * жеста), а pointerUp после перезагрузки уже не придёт.
 */
function sanitizeEditor(e: EditorState): EditorState {
  return {
    ...e,
    drawing: false,
    stroke: [],
    dragStart: null,
    dragEnd: null,
    dragEdge: null,
    dragIndex: null,
  };
}
