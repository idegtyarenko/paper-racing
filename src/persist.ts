// Сохранение локального стейта игры в localStorage, чтобы перезагрузка страницы
// (swipe-to-reload, кнопка/жест «назад», сворачивание вкладки на телефоне) не
// сбрасывала игру к первому экрану рисования трассы. Онлайн сюда не попадает —
// его сессия живёт на сервере и восстанавливается своим путём.

import { AppState, PanelMode, LastLocalRace } from './app-state';
import { EditorState } from './model/editor';
import { Track } from './model/track';
import { GameState, Rules } from './model/game';
import {
  SerializedTrack,
  SerializedState,
  serializeTrack,
  deserializeTrack,
  serializeState,
  deserializeState,
} from './online/net';

const KEY = 'pr-local-state';
// v3: бот-ность мест переехала в стейт (Player.bot) — отдельного поля `ai` больше
// нет, а lastLocalRace хранит состав (люди+боты+сложность). Старые снимки (v2 с
// сайд-каналом ai / прежним lastLocalRace) несовместимы — их отбрасываем.
const VERSION = 3;

/** Живой снимок локального состояния приложения (то, что держит main.ts). Бот-места
 *  едут внутри game.players (Player.bot) — отдельного поля под ботов нет. */
export interface LocalSnapshot {
  mode: PanelMode;
  editor: EditorState;
  raceTrack: Track | null;
  game: GameState | null;
  rules: Rules;
  playersReturn: 'edit' | 'race';
  lastLocalRace: LastLocalRace | null;
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
}

/** Записать снимок. Принимает всё состояние приложения, но сохраняет лишь
 *  персистентное подмножество (cands/pending/raceNav — производные, не пишем).
 *  Ошибку записи (квота/приватный режим) молча глотаем. */
export function save(snap: AppState): void {
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
