import { describe, it, expect } from 'vitest';
import { newGame, Rules, DEFAULT_RULES, Candidate, Player, GameState } from './game';
import {
  simultaneousCandidates,
  submitBlindMove,
  nextPickSeat,
  allSubmitted,
  resolveRound,
} from './simultaneous';
import { WIN_CROSSINGS } from '../config';
import { key } from './track';
import { ringTrack } from './test-fixtures';

const BLIND: Rules = { ...DEFAULT_RULES, turnMode: 'simultaneous' };

/** Кандидат по целевой клетке (resolveRound сам пересчитывает исход, crash не важен). */
const scand = (x: number, y: number): Candidate => ({
  target: { x, y },
  crash: false,
  blocked: false,
  inertial: false,
});

function place(p: Player, pos: [number, number], vel: [number, number] = [0, 0]): void {
  p.pos = { x: pos[0], y: pos[1] };
  p.vel = { x: vel[0], y: vel[1] };
}

/** Игра на 2 игрока в режиме вслепую. */
function blindGame(n = 2): GameState {
  return newGame(ringTrack(), n, BLIND);
}

describe('simultaneousCandidates', () => {
  it('9 кандидатов, ровно один инерционный', () => {
    const g = blindGame();
    place(g.players[0], [10, 4], [2, 1]);
    const cs = simultaneousCandidates(g, 0);
    expect(cs).toHaveLength(9);
    expect(cs.filter((c) => c.inertial)).toHaveLength(1);
  });

  it('не блокирует занятые соперником клетки — можно целиться сквозь', () => {
    const g = blindGame();
    place(g.players[0], [10, 4], [2, 0]);
    place(g.players[1], [13, 4]); // цель (13,4); и (11,4) на пути инерции
    const cs = simultaneousCandidates(g, 0);
    expect(cs.every((c) => !c.blocked)).toBe(true);
  });

  it('crash помечается за стенкой', () => {
    const g = blindGame();
    place(g.players[0], [10, 2], [0, -2]);
    const below = simultaneousCandidates(g, 0).filter((c) => c.target.y === -1);
    expect(below.every((c) => c.crash)).toBe(true);
  });
});

describe('поток выбора вслепую', () => {
  it('nextPickSeat идёт по активным местам, allSubmitted — когда все выбрали', () => {
    const g = blindGame();
    place(g.players[0], [10, 3]);
    place(g.players[1], [10, 5]);
    expect(nextPickSeat(g)).toBe(0);
    submitBlindMove(g, 0, scand(11, 3));
    expect(nextPickSeat(g)).toBe(1);
    expect(allSubmitted(g)).toBe(false);
    submitBlindMove(g, 1, scand(11, 5));
    expect(nextPickSeat(g)).toBe(null);
    expect(allSubmitted(g)).toBe(true);
  });

  it('место, отбывающее штраф, пропускается при выборе', () => {
    const g = blindGame();
    place(g.players[0], [10, 3]);
    place(g.players[1], [10, 5]);
    g.players[0].skipTurns = 2;
    expect(nextPickSeat(g)).toBe(1); // p0 в гравии — не выбирает
  });
});

describe('resolveRound — применение и раскрытие', () => {
  it('несходящиеся ходы применяются: pos/vel обновляются, раунд открывается заново', () => {
    const g = blindGame();
    place(g.players[0], [10, 3]);
    place(g.players[1], [10, 5]);
    submitBlindMove(g, 0, scand(11, 3));
    submitBlindMove(g, 1, scand(11, 5));
    resolveRound(g);
    expect(g.players[0].pos).toEqual({ x: 11, y: 3 });
    expect(g.players[0].vel).toEqual({ x: 1, y: 0 });
    expect(g.players[1].pos).toEqual({ x: 11, y: 5 });
    expect(g.pending).toEqual([null, null]); // новый раунд
    expect(g.current).toBe(0);
  });

  it('столкновение: два болида в одну клетку → у обоих скорость обнуляется', () => {
    const g = blindGame();
    place(g.players[0], [10, 4]);
    place(g.players[1], [12, 4]);
    submitBlindMove(g, 0, scand(11, 4)); // оба целятся в (11,4)
    submitBlindMove(g, 1, scand(11, 4));
    resolveRound(g);
    expect(g.players[0].pos).toEqual({ x: 11, y: 4 });
    expect(g.players[1].pos).toEqual({ x: 11, y: 4 });
    expect(g.players[0].vel).toEqual({ x: 0, y: 0 });
    expect(g.players[1].vel).toEqual({ x: 0, y: 0 });
  });
});

describe('resolveRound — финиш и победа', () => {
  it('финиш в раунде завершает игру; победитель — заехавший дальше', () => {
    const g = blindGame();
    place(g.players[0], [5, 4]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    place(g.players[1], [10, 6]);
    submitBlindMove(g, 0, scand(8, 4)); // за линию, overshoot 2
    submitBlindMove(g, 1, scand(11, 6)); // не финиширует
    resolveRound(g);
    expect(g.phase).toBe('over');
    expect(g.winner).toBe(0);
  });

  it('равная глубина заезда финишировавших → ничья', () => {
    const g = blindGame();
    place(g.players[0], [5, 3]);
    place(g.players[1], [5, 5]);
    g.players[0].crossings = WIN_CROSSINGS - 1;
    g.players[1].crossings = WIN_CROSSINGS - 1;
    submitBlindMove(g, 0, scand(7, 3)); // оба заезжают на x=7
    submitBlindMove(g, 1, scand(7, 5));
    resolveRound(g);
    expect(g.phase).toBe('over');
    expect(g.winner).toBe('draw');
  });
});

describe('resolveRound — штраф за аварию', () => {
  it('свежеразбившийся пропускает раунды и возвращается на трассу после отбытия', () => {
    const g = blindGame();
    place(g.players[0], [10, 1]);
    place(g.players[1], [10, 4]);
    // Раунд 1: p0 вылетает сквозь стенку (скорость 3 → штраф 3), p1 едет.
    submitBlindMove(g, 0, scand(10, -2));
    submitBlindMove(g, 1, scand(11, 4));
    resolveRound(g);
    const crashed = g.players[0];
    expect(crashed.skipTurns).toBe(3);
    const gravel = { ...crashed.pos };

    // Дальше p0 в гравии не выбирает; каждый раунд его штраф −1.
    let guard = 0;
    while (crashed.skipTurns > 0 && guard++ < 10) {
      expect(nextPickSeat(g)).toBe(1); // выбирает только p1
      const p1 = g.players[1];
      submitBlindMove(g, 1, scand(p1.pos.x, p1.pos.y + 1));
      const before = crashed.skipTurns;
      resolveRound(g);
      if (crashed.skipTurns > 0) expect(crashed.pos).toEqual(gravel); // ещё в гравии
      expect(crashed.skipTurns).toBe(before - 1);
    }
    expect(crashed.skipTurns).toBe(0);
    expect(g.track.inside.has(key(crashed.pos.x, crashed.pos.y))).toBe(true);
    expect(crashed.trail.some((s) => s.jump)).toBe(true);
  });

  it('все болиды в гравии — пустые раунды проматываются без тупика', () => {
    const g = blindGame();
    place(g.players[0], [10, 1]);
    place(g.players[1], [11, 1]);
    submitBlindMove(g, 0, scand(10, -2)); // оба вылетают этим раундом
    submitBlindMove(g, 1, scand(11, -2));
    resolveRound(g);
    // Оба в штрафе → нового выбирающего нет сразу, но resolveRound промотал
    // пустые раунды до возврата обоих на трассу.
    expect(g.phase).toBe('race');
    expect(nextPickSeat(g)).not.toBe(null);
    expect(g.players[0].skipTurns).toBe(0);
    expect(g.players[1].skipTurns).toBe(0);
    expect(g.track.inside.has(key(g.players[0].pos.x, g.players[0].pos.y))).toBe(true);
    expect(g.track.inside.has(key(g.players[1].pos.x, g.players[1].pos.y))).toBe(true);
  });
});
