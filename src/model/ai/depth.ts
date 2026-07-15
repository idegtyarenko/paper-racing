// Перебор с ограниченной глубиной для easy/medium: поиск по потенциалу
// phi = dist + (осталось пересечений − 1)·круг, плюс инвариант «успею ли
// затормозить» (canStop). Чистая логика без DOM.
//
// Быстро, но оптимизирует ПУТЬ (расстояние), а не время — отсюда более «жадная»
// линия, чем у A*-планировщика hard (planner.ts).

import { Vec, dist } from '../../geometry';
import { sideOfFinish } from '../track';
import {
  GameState,
  Candidate,
  MoveOutcome,
  WIN_CROSSINGS,
  computeOutcome,
} from '../game';
import { NavField, navAt } from '../nav';
import { DifficultyParams } from './difficulty';
import { ACCELS } from './targets';
import {
  Ranking,
  AVG_SPEED,
  RESTART_TURNS,
  UNSAFE_PENALTY,
  OVERSPEED_PENALTY,
  FINISH_BONUS,
  FINISH_DELAY_COST,
} from './scoring';

/** Ранжирование корней перебором глубины по потенциалу (easy/medium). */
export function scoreByDepth(
  state: GameState,
  nav: NavField,
  open: Candidate[],
  P: DifficultyParams,
): Ranking {
  const { track, rules } = state;
  const me = state.players[state.current];
  const left0 = WIN_CROSSINGS - me.crossings;

  const outcomeMemo = new Map<string, MoveOutcome>();
  const searchMemo = new Map<string, number>();
  const stopMemo = new Map<string, boolean>();
  const outcome = (from: Vec, to: Vec): MoveOutcome => {
    const k = `${from.x},${from.y}:${to.x},${to.y}`;
    let o = outcomeMemo.get(k);
    if (!o) {
      o = computeOutcome(track, rules, from, to);
      outcomeMemo.set(k, o);
    }
    return o;
  };
  const phi = (p: Vec, left: number): number => navAt(nav, p) + (left - 1) * nav.lap;

  const canStop = (pos: Vec, vel: Vec, cap: number): boolean => {
    if (vel.x === 0 && vel.y === 0) return true;
    if (cap <= 0) return true;
    const k = `${pos.x},${pos.y},${vel.x},${vel.y},${cap}`;
    const hit = stopMemo.get(k);
    if (hit !== undefined) return hit;
    const byBraking = ACCELS.slice().sort(
      (a, b) =>
        Math.hypot(vel.x + a.x, vel.y + a.y) - Math.hypot(vel.x + b.x, vel.y + b.y),
    );
    let ok = false;
    for (const a of byBraking) {
      const o = outcome(pos, { x: pos.x + vel.x + a.x, y: pos.y + vel.y + a.y });
      if (!o.crash && canStop(o.end, o.vel, cap - 1)) {
        ok = true;
        break;
      }
    }
    stopMemo.set(k, ok);
    return ok;
  };

  const valueOf = (o: MoveOutcome, leftBefore: number, depth: number): number => {
    const left = leftBefore - o.crossingDelta;
    if (left <= 0) {
      const delay = P.depth - 1 - depth;
      return -FINISH_BONUS + delay * FINISH_DELAY_COST - sideOfFinish(track, o.end);
    }
    if (o.crash) {
      return phi(o.end, left) + (o.skipTurns + RESTART_TURNS) * AVG_SPEED;
    }
    if (depth <= 0) {
      return phi(o.end, left) + (canStop(o.end, o.vel, P.stopCap) ? 0 : UNSAFE_PENALTY);
    }
    const k = `${o.end.x},${o.end.y},${o.vel.x},${o.vel.y},${left},${depth}`;
    const hit = searchMemo.get(k);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const a of ACCELS) {
      const target = { x: o.end.x + o.vel.x + a.x, y: o.end.y + o.vel.y + a.y };
      best = Math.min(best, valueOf(outcome(o.end, target), left, depth - 1));
    }
    searchMemo.set(k, best);
    return best;
  };

  const scored = open.map((c) => {
    let score = valueOf(outcome(me.pos, c.target), left0, P.depth - 1);
    const speed = dist(me.pos, c.target);
    if (speed > P.maxSpeed) score += (speed - P.maxSpeed) * OVERSPEED_PENALTY;
    return { c, score };
  });
  let best = scored[0];
  for (const s of scored) if (s.score < best.score) best = s;
  const terminal = best.score < -FINISH_BONUS / 2 || best.score > FINISH_BONUS / 2;
  return { best: best.c, terminal, scored };
}
