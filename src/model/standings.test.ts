import { describe, it, expect } from 'vitest';
import { newGame } from './game';
import { buildNavField } from './nav';
import { computeStandings } from './standings';
import { WIN_CROSSINGS } from '../config';
import { ringTrack } from './test-fixtures';

/** Общая фикстура: 4 болида на кольце + навигационное поле трассы. */
function setup() {
  const track = ringTrack();
  return { g: newGame(track, 4), nav: buildNavField(track) };
}

describe('computeStandings', () => {
  it('финишировавшие — по месту, впереди едущих и сошедших', () => {
    const { g, nav } = setup();
    g.players[0].place = 2;
    g.players[1].place = 1;
    g.players[2].retired = true;
    // p3 — ещё едет (place null, не retired)
    expect(computeStandings(g, nav)).toEqual([1, 0, 3, 2]);
  });

  it('среди едущих выше тот, кому осталось меньше кругов', () => {
    const { g, nav } = setup();
    // p2 отъездил на круг больше — ближе к победе, значит выше.
    g.players[2].crossings = WIN_CROSSINGS - 1;
    // остальные на старте (crossings 0). Ставим их всех в одну точку, чтобы
    // разницу давал только счётчик кругов, а не позиция на трассе.
    const spot = { ...g.players[2].pos };
    [0, 1, 3].forEach((i) => (g.players[i].pos = { ...spot }));
    expect(computeStandings(g, nav)[0]).toBe(2);
  });

  it('сошедшие — в самом конце, в порядке мест (seat)', () => {
    const { g, nav } = setup();
    g.players[0].retired = true;
    g.players[2].retired = true;
    const order = computeStandings(g, nav);
    expect(order.slice(-2)).toEqual([0, 2]);
  });

  it('болид, пересёкший финиш в неразрешённом раунде, идёт впереди ещё едущих', () => {
    const { g, nav } = setup();
    // p1 уже пересёк финиш нужное число раз (place ещё не присвоен — раунд идёт).
    g.players[1].crossings = WIN_CROSSINGS;
    expect(computeStandings(g, nav)[0]).toBe(1);
  });
});
