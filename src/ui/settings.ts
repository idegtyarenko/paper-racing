// Лист-модалка настроек правил заезда: тип штрафа за вылет (по скорости или
// статический), строгость динамической формулы, размер статического штрафа и
// (в онлайне) порядок ходов. Владеет своими DOM-элементами; текущие правила
// держит вызывающий — сюда они приходят копией, а изменения уезжают через onChange.

import { Rules } from '../model/game';
import { CRASH_EXPONENT_STANDARD, CRASH_EXPONENT_STRICT } from '../config';
import { bindTap, openSheet } from './dom';

const sheet = document.getElementById('settingsSheet')!;
const penaltyType = document.getElementById('penaltyType')!;
const exponentRow = document.getElementById('exponentRow')!;
const exponentType = document.getElementById('exponentType')!;
const staticRow = document.getElementById('staticRow')!;
const staticSlider = document.getElementById('staticSlider') as HTMLInputElement;
const staticTurnsValue = document.getElementById('staticTurnsValue')!;
const turnModeRow = document.getElementById('turnModeRow')!;
const turnModeType = document.getElementById('turnModeType')!;
const turnOrderRow = document.getElementById('turnOrderRow')!;
const turnOrderType = document.getElementById('turnOrderType')!;

/** Показатель степени, соответствующий выбору сегмента строгости. */
const exponentOf = (kind: string): number =>
  kind === 'strict' ? CRASH_EXPONENT_STRICT : CRASH_EXPONENT_STANDARD;

// Рабочая копия правил (мутируется контролами) и колбэк наружу — задаются при открытии.
let rules: Rules;
let onChange: ((r: Rules) => void) | null = null;

/** Обновить вид контролов под текущие rules (активные сегменты, значения, видимость строк). */
function render(): void {
  penaltyType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.penalty === rules.penalty);
  });
  exponentType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle(
      'seg__btn--active',
      exponentOf(btn.dataset.exponent!) === rules.dynamicExponent,
    );
  });
  turnModeType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.turn === rules.turnMode);
  });
  turnOrderType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.order === rules.turnOrder);
  });
  // Очерёдность имеет смысл только когда игроки ходят по очереди.
  turnOrderRow.hidden = rules.turnMode !== 'sequential';
  const dynamic = rules.penalty === 'dynamic';
  exponentRow.hidden = !dynamic;
  staticRow.hidden = dynamic;
  staticSlider.value = String(rules.staticTurns);
  staticTurnsValue.textContent = String(rules.staticTurns);
}

/** Применить изменение правил: перерисовать и уведомить вызывающего. */
function commit(): void {
  render();
  onChange?.(rules);
}

/**
 * Открыть настройки. current — текущие правила (копируем: изменения сразу отдаём
 * через onChange, чужой объект не трогаем). online — онлайн-заезд: порядок ходов
 * пока поддержан только локально, поэтому в онлайне строку показываем заглушкой
 * (кнопки disabled, всегда последовательный) — включится, когда сядет онлайн-часть.
 */
export function openSettings(
  current: Rules,
  online: boolean,
  onChangeCb: (r: Rules) => void,
): void {
  rules = { ...current };
  onChange = onChangeCb;
  turnModeRow.hidden = false;
  turnModeType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.disabled = online;
  });
  render();
  openSheet(sheet);
}

/** Навесить обработчики сегментов и ползунка (один раз при инициализации панели). */
export function bindSettings(): void {
  penaltyType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      rules.penalty = btn.dataset.penalty as Rules['penalty'];
      commit();
    });
  });
  exponentType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      rules.dynamicExponent = exponentOf(btn.dataset.exponent!);
      commit();
    });
  });
  staticSlider.addEventListener('input', () => {
    rules.staticTurns = Number(staticSlider.value);
    commit();
  });
  turnModeType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      rules.turnMode = btn.dataset.turn as Rules['turnMode'];
      commit();
    });
  });
  turnOrderType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      rules.turnOrder = btn.dataset.order as Rules['turnOrder'];
      commit();
    });
  });
}
