// Тестовые фикстуры для чистого ядра. Не входят в бандл (только *.test.ts их
// импортируют). Строим реальную трассу через finalizeTrack, чтобы inside/
// startPoints считались настоящей логикой, а не подделывались руками.

import { Vec, Polyline } from '../geometry';
import { Track, finalizeTrack } from './track';
import { GameState, Rules, newGame } from './game';

/**
 * Прямоугольное «кольцо» (пончик): дорога — рамка между внешним и внутренним
 * прямоугольниками. Нижняя прямая (y ≈ 1..7, x ≈ 1..39) — широкий коридор с
 * кучей узлов сетки, удобный для детерминированной геометрии ходов/аварий.
 * Финиш поперёк нижней прямой у x=6, гонка идёт в +x (forward = {1,0}), поэтому
 * sideOfFinish(p) = p.x − 6: старты (behind) — слева от линии.
 */
export const OUTER: Polyline = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 24 },
  { x: 0, y: 24 },
];
export const INNER: Polyline = [
  { x: 8, y: 8 },
  { x: 32, y: 8 },
  { x: 32, y: 16 },
  { x: 8, y: 16 },
];
export const FINISH = { a: { x: 6, y: 0 }, b: { x: 6, y: 8 } };
export const FORWARD: Vec = { x: 1, y: 0 };

export function ringTrack(): Track {
  const res = finalizeTrack(OUTER, INNER, FINISH, FORWARD);
  if ('error' in res) throw new Error(`ringTrack fixture invalid: ${res.error}`);
  return res.track;
}

export function gameOn(track: Track, players = 2, rules?: Rules): GameState {
  return newGame(track, players, rules);
}
