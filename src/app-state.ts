// Единое состояние приложения. Раньше жило дюжиной модульных `let` в main.ts, а
// онлайн/ввод дотягивались до них через десятки get/set-переходников. Теперь это
// один объект: main.ts владеет им, а online-controller и input читают и мутируют
// его по ссылке (`deps.state.game = …`). Служебные ручки (таймер хода бота) сюда не
// кладём — здесь только данные. Сохранение (persist.ts) сериализует его подмножество.
//
// Здесь же живут кросс-слойные типы `Phase` и `LastLocalRace`: без этого
// persist/view/online тянули бы `ui/panel` ради одного типа (лишнее ребро графа).

import { EditorState, newEditor } from './model/editor';
import { Track } from './model/track';
import { GameState, Candidate, Rules, DEFAULT_RULES } from './model/game';
import { NavField } from './model/nav';
import { Difficulty } from './model/ai';

/** Экран/фаза приложения: рисование трассы, выбор режима/числа игроков/сложности
 *  ботов, лобби, гонка. */
export type Phase = 'edit' | 'modeSelect' | 'players' | 'ai' | 'lobby' | 'race';

/** Последний локальный состав — для «По той же трассе» одним тапом. Покрывает и
 *  хотсит (bots 0), и игру против компьютера (humans 1). */
export type LastLocalRace = { humans: number; bots: number; difficulty: Difficulty };

/** Состояние приложения — единый источник правды для main/online/input. */
export interface AppState {
  /** Текущий экран/фаза. */
  phase: Phase;
  /** Состояние мастера рисования трассы. */
  editor: EditorState;
  /**
   * Готовая трасса, ожидающая выбора числа игроков (шаг «players»). Приходит либо
   * из редактора после выбора направления, либо из «Новая гонка → та же трасса».
   */
  raceTrack: Track | null;
  /** Куда вернуться из шага выбора игроков по «Назад»: в редактор или в гонку. */
  playersReturn: 'edit' | 'race';
  /**
   * Последний локальный состав (люди + боты + сложность) — чтобы «По той же трассе»
   * стартовала одним тапом, без повторного мастера. Онлайн сюда не попадает: рематч
   * того же состава — отдельная задача.
   */
  lastLocalRace: LastLocalRace | null;
  /** Текущая гонка. null — вне гонки. */
  game: GameState | null;
  /** Кандидаты хода для веера места-владельца. null — веера нет. */
  cands: Candidate[] | null;
  /**
   * Предвыбор хода («наметка»): кандидат, намеченный своим местом ещё в чужую очередь
   * (онлайн/vs-боты), ждущий ручного подтверждения «Газу!» в свой ход. Живёт здесь, а
   * не в input.selected (тот транзиентный и стирается каждым refreshCands). null — нет.
   */
  pending: Candidate | null;
  /** Правила заезда, выбранные в настройках (⚙). В онлайне их задаёт хост. */
  rules: Rules;
  /**
   * Навигационное поле трассы текущей гонки (расстояния до финиша). Нужно ботам
   * (chooseMove) и полосе текущих мест (renderStandings). null — вне гонки.
   */
  raceNav: NavField | null;
}

/** Свежее состояние приложения: чистый редактор, правила по умолчанию. */
export function newAppState(): AppState {
  return {
    phase: 'edit',
    editor: newEditor(),
    raceTrack: null,
    playersReturn: 'edit',
    lastLocalRace: null,
    game: null,
    cands: null,
    pending: null,
    rules: { ...DEFAULT_RULES },
    raceNav: null,
  };
}
