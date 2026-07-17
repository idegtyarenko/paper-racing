// Полоса текущих мест над картой в стиле Ф1-трансляций: башня строк «позиция —
// болид — имя», отсортированных от лидера к аутсайдеру. Порядок замораживается на
// границе круга (см. frozenOrder ниже) — внутри круга он эфемерен, потому что болиды
// сделали разное число ходов; статусы строк при этом живые. Финишировавшим
// показываем 🏁 и занятое место, сошедшим — 🏳️. Порядок считает
// computeStandings() (по местам / по оставшейся дистанции). Модуль сам владеет
// своим корневым элементом и монтирует его в .app__board при первом показе —
// разметки в index.html для него нет (не растим index.html, см. роадмап).

import { GameState } from '../model/game';
import { NavField } from '../model/nav';
import { computeStandings } from '../model/standings';
import { strings } from '../strings';

let root: HTMLElement | null = null;

// Порядок мест замораживаем на границе круга: внутри круга разные болиды сделали
// разное число ходов (ходящий уже сходил, остальные — нет), поэтому «живой»
// порядок эфемерен и скачет. Пересчитываем computeStandings только когда
// завершился полный круг (floor(turn/n) вырос) — тогда все болиды круга сделали по
// ходу и сравнение честное. Между границами держим замороженный порядок; статусы
// строк (🏁/🏳️/текущий) при этом остаются живыми — замораживаем только сортировку.
let frozenOrder: number[] = [];
let frozenRound = -1;
let frozenCount = 0;

/** Создать корневой элемент полосы и смонтировать его над картой (однократно). */
function mount(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'standings';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', strings.race.standingsLabel);
  el.hidden = true;
  (document.querySelector('.app__board') ?? document.body).append(el);
  return el;
}

/** Одна строка башни: позиция/статус, цветной кружок болида, имя. */
function row(game: GameState, seat: number, index: number): HTMLElement {
  const p = game.players[seat];
  const el = document.createElement('div');
  el.className = 'standings__row';
  if (p.place !== null) el.classList.add('standings__row--finished');
  else if (p.retired) el.classList.add('standings__row--retired');
  else if (game.phase === 'race' && game.current === seat)
    el.classList.add('standings__row--current');

  const pos = document.createElement('span');
  pos.className = 'standings__pos';
  // Финишировавший — 🏁 и реальное (возможно, делённое) место; сошедший — 🏳️;
  // едущий — текущая позиция в общем зачёте (номер строки).
  pos.textContent = p.retired ? '🏳️' : p.place !== null ? `🏁${p.place}` : `${index + 1}`;

  const dot = document.createElement('span');
  dot.className = 'standings__dot';
  dot.style.background = p.color;

  const name = document.createElement('span');
  name.className = 'standings__name';
  name.textContent = p.name;

  el.append(pos, dot, name);
  return el;
}

/**
 * Обновить полосу мест. Показываем в идущей и завершённой гонке (после финиша —
 * итоговая расстановка); прячем вне гонки. nav — навигационное поле трассы для
 * оценки дистанции ещё едущих болидов.
 */
export function renderStandings(game: GameState | null, nav: NavField | null): void {
  if (!root) root = mount();
  if (!game || !nav || (game.phase !== 'race' && game.phase !== 'over')) {
    root.hidden = true;
    root.replaceChildren();
    frozenRound = -1; // сброс на выходе из гонки — новая гонка пересчитает с нуля
    return;
  }
  const n = game.players.length;
  const round = Math.floor(game.turn / n);
  // Пересчитываем порядок на границе круга, при смене числа игроков (иная гонка) и
  // в завершённой гонке (итоговая расстановка). Иначе держим замороженный порядок.
  if (round !== frozenRound || n !== frozenCount || game.phase === 'over') {
    frozenOrder = computeStandings(game, nav);
    frozenRound = round;
    frozenCount = n;
  }
  root.replaceChildren(...frozenOrder.map((seat, i) => row(game, seat, i)));
  root.hidden = false;
}
