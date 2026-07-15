// Планировщик A* хода hard-бота: поиск по состояниям (pos, vel), минимизирующий
// ЧИСЛО ХОДОВ до следующего пересечения финиша вперёд. Чистая логика без DOM.
//
// Так рождаются гоночная траектория (широкий заход → апекс → выход) и торможение
// перед поворотом, а стоек/езды назад не возникает (каждый ход стоит +1). Проверку
// аварии в поиске делает дешёвый растр зазора (clearance.ts), а не густой
// computeOutcome — это и даёт глубокий поиск в пределах паузы AI_MOVE_DELAY_MS.
//
// Соперники учитываются только на первом слое (blocked-ходы отсеяны в candidates()):
// нельзя встать на чужую клетку или проехать сквозь неё — к более глубоким слоям они
// всё равно сдвинутся, а A* при занятой оптимальной клетке строит план в объезд.

import { Vec, dist, segSegIntersection } from '../../geometry';
import { Track, sideOfFinish } from '../track';
import { GameState, Candidate, WIN_CROSSINGS, computeOutcome } from '../game';
import { NavField, navAt } from '../nav';
import { reachableTargets } from '../turns';
import { Clearance, buildClearance, segClear } from './clearance';
import { PlanParams } from './difficulty';
import { Ranking, OVERSPEED_PENALTY, EPS_MARGIN } from './scoring';

/** Растр зазора кэшируем на трассу: строится раз на гонку при первом ходе hard-бота
 *  (маскируется паузой перед ходом), дальше переиспользуется всеми болидами. */
const clearanceCache = new WeakMap<Track, Clearance>();
function clearanceFor(track: Track): Clearance {
  let c = clearanceCache.get(track);
  if (!c) {
    c = buildClearance(track);
    clearanceCache.set(track, c);
  }
  return c;
}

/** Направление пересечения финиша ходом from→to: +1 вперёд, −1 назад, 0 нет.
 *  Та же семантика, что crossDir в nav.ts (точка ровно на линии — сторона «впереди»). */
function crossDelta(track: Track, from: Vec, to: Vec): number {
  if (!segSegIntersection(from, to, track.finish.a, track.finish.b)) return 0;
  const sf = sideOfFinish(track, from);
  const st = sideOfFinish(track, to);
  if (sf < 0 && st >= 0) return 1;
  if (sf >= 0 && st < 0) return -1;
  return 0;
}

// ── Мин-куча узлов A* по f с детерминированным тай-брейком по порядку вставки ──
interface Node {
  pos: Vec;
  vel: Vec;
  g: number; // ходов от старта
  f: number; // g + эвристика (у цели h=0, f=g)
  first: number; // индекс корневого хода, из которого выросла ветка
  goal: boolean; // узел — пересечение финиша вперёд (завершённый план длины g)
}
class Heap {
  private a: Node[] = [];
  private seq: number[] = [];
  private n = 0;
  private less(i: number, j: number): boolean {
    return this.a[i].f !== this.a[j].f
      ? this.a[i].f < this.a[j].f
      : this.seq[i] < this.seq[j];
  }
  private swap(i: number, j: number): void {
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    [this.seq[i], this.seq[j]] = [this.seq[j], this.seq[i]];
  }
  push(node: Node): void {
    this.a.push(node);
    this.seq.push(this.n++);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): Node | undefined {
    const len = this.a.length;
    if (len === 0) return undefined;
    const top = this.a[0];
    const last = this.a.pop()!;
    const lastSeq = this.seq.pop()!;
    if (len > 1) {
      this.a[0] = last;
      this.seq[0] = lastSeq;
      let i = 0;
      const size = this.a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < size && this.less(l, m)) m = l;
        if (r < size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  get size(): number {
    return this.a.length;
  }
}

/** Ранжирование корней планировщиком A* (все уровни). */
export function scoreByPlan(
  state: GameState,
  nav: NavField,
  open: Candidate[],
  plan: PlanParams,
  maxSpeed: number,
  stopCap: number,
  enforceStop: boolean,
): Ranking {
  const { track, rules } = state;
  const drive = rules.drive;
  const me = state.players[state.current];
  const cl = clearanceFor(track);

  // Точный исход первого хода для каждого кандидата: корни исполняются реально,
  // поэтому вету аварии/пересечения им доверяем движку (≤9 вызовов, дёшево), а не
  // растру — растр (шаг грубее) годится лишь для внутренних узлов поиска, которые
  // не исполняются. Так первый ход бота гарантированно безаварийный.
  const rootOutcome = open.map((c) => computeOutcome(track, rules, me.pos, c.target));

  // Победный ход вне конкуренции — берём с максимальным заездом за линию (тай-брейк
  // решающего круга), при равенстве предпочитая безаварийный.
  let win: Candidate | null = null;
  let winKey = -Infinity;
  open.forEach((c, i) => {
    const o = rootOutcome[i];
    if (me.crossings + o.crossingDelta >= WIN_CROSSINGS) {
      const key = sideOfFinish(track, o.end) + (o.crash ? -1e3 : 0);
      if (key > winKey) {
        winKey = key;
        win = c;
      }
    }
  });
  if (win) return { best: win, terminal: true, scored: [] };

  // Инвариант безопасности на растре: из состояния (pos,vel) можно затормозить до
  // остановки, ни разу не вылетев (за cap ходов; на срезе — оптимистично «успею»).
  // A* минимизирует ходы и без этого разгоняется в тупик у далёкого поворота, когда
  // бюджета не хватает дотянуть план до финиша и включается жадный fallback. Дёшево
  // (растр), поэтому проверяем на каждом корне.
  const stopMemo = new Map<string, boolean>();
  const canStop = (pos: Vec, vel: Vec, cap: number): boolean => {
    if (vel.x === 0 && vel.y === 0) return true;
    if (cap <= 0) return true;
    const key = `${pos.x},${pos.y},${vel.x},${vel.y},${cap}`;
    const hit = stopMemo.get(key);
    if (hit !== undefined) return hit;
    // Пробуем сильнее тормозить первыми — быстрее находим цепочку до нуля.
    const opts = reachableTargets(pos, vel, drive).sort(
      (A, B) =>
        Math.hypot(A.x - pos.x, A.y - pos.y) - Math.hypot(B.x - pos.x, B.y - pos.y),
    );
    let ok = false;
    for (const t of opts) {
      if (crossDelta(track, pos, t) === -1 || !segClear(cl, pos, t)) continue;
      if (canStop(t, { x: t.x - pos.x, y: t.y - pos.y }, cap - 1)) {
        ok = true;
        break;
      }
    }
    stopMemo.set(key, ok);
    return ok;
  };

  // Корни — ходы без аварии (движок) и без пересечения финиша назад. Предпочитаем
  // те, из которых гарантированно можно затормозить (инвариант безопасности); если
  // безопасных нет — берём любые не-аварийные (не крашиться лучше, чем краш).
  const noCrash: number[] = [];
  open.forEach((c, i) => {
    if (!rootOutcome[i].crash && rootOutcome[i].crossingDelta !== -1) noCrash.push(i);
  });
  // enforceStop: предпочитаем корни, из которых гарантированно тормозим (medium/hard
  // едут чисто). easy (enforceStop=false) идёт по краю — берём любые не-аварийные, и
  // иногда не успевает затормозить → авария (намеренная «живость» слабого уровня).
  const safe = enforceStop
    ? noCrash.filter((i) => {
        const o = rootOutcome[i];
        return o.crossingDelta === 1 || canStop(o.end, o.vel, stopCap);
      })
    : noCrash;
  const rootIdx = safe.length > 0 ? safe : noCrash;
  // Все ходы — авария: выбираем наименьший штраф простоя.
  if (rootIdx.length === 0) {
    let best = open[0];
    let bestSkip = Infinity;
    open.forEach((c, i) => {
      if (rootOutcome[i].skipTurns < bestSkip) {
        bestSkip = rootOutcome[i].skipTurns;
        best = c;
      }
    });
    return { best, terminal: true, scored: [] };
  }

  const overspeed = (from: Vec, to: Vec): number => {
    const sp = dist(from, to);
    return sp > maxSpeed ? (sp - maxSpeed) * OVERSPEED_PENALTY : 0;
  };
  const hMemo = new Map<number, number>();
  const h = (p: Vec): number => {
    const k = (p.x + 512) * 4096 + (p.y + 512);
    let v = hMemo.get(k);
    if (v === undefined) {
      v = (plan.weight * navAt(nav, p)) / plan.vref;
      hMemo.set(k, v);
    }
    return v;
  };

  const heap = new Heap();
  const closed = new Map<string, number>(); // состояние (pos,vel) → лучший g
  const sk = (p: Vec, v: Vec) => `${p.x},${p.y},${v.x},${v.y}`;
  const push = (pos: Vec, vel: Vec, g: number, first: number, goal: boolean) => {
    heap.push({ pos, vel, g, f: goal ? g : g + h(pos), first, goal });
  };

  // Посев фронтира корнями. Корень, сразу пересекающий финиш, — цель длины 1.
  for (const i of rootIdx) {
    const target = open[i].target;
    const g = 1 + overspeed(me.pos, target);
    if (rootOutcome[i].crossingDelta === 1) {
      push(target, { x: 0, y: 0 }, g, i, true);
    } else {
      const vel = { x: target.x - me.pos.x, y: target.y - me.pos.y };
      push(target, vel, g, i, false);
      closed.set(sk(target, vel), g);
    }
  }

  // Стоимость плана по корням: min длина завершённого плана, начавшегося с корня.
  const rootPlan = new Map<number, number>();
  let bestPlan = Infinity;
  let fallbackFirst = rootIdx[0];
  let fallbackF = Infinity;
  let exp = 0;
  while (heap.size > 0 && exp < plan.budget) {
    const cur = heap.pop()!;
    if (cur.goal) {
      // Цель снята с кучи по возрастанию f=g — оптимально. Собираем корни с планом
      // в полосе EPS от лучшего (для расталкивания), дальше — можно прекращать.
      if (cur.g < bestPlan) bestPlan = cur.g;
      const prev = rootPlan.get(cur.first);
      if (prev === undefined || cur.g < prev) rootPlan.set(cur.first, cur.g);
      if (cur.f > bestPlan + EPS_MARGIN) break;
      continue;
    }
    if ((closed.get(sk(cur.pos, cur.vel)) ?? Infinity) < cur.g) continue;
    if (cur.f < fallbackF) {
      fallbackF = cur.f;
      fallbackFirst = cur.first;
    }
    exp++;
    for (const target of reachableTargets(cur.pos, cur.vel, drive)) {
      const cd = crossDelta(track, cur.pos, target);
      if (cd === -1) continue; // назад через финиш не едем
      const g = cur.g + 1 + overspeed(cur.pos, target);
      if (cd === 1) {
        push(target, { x: 0, y: 0 }, g, cur.first, true);
        continue;
      }
      if (!segClear(cl, cur.pos, target)) continue;
      const vel = { x: target.x - cur.pos.x, y: target.y - cur.pos.y };
      const key = sk(target, vel);
      const prev = closed.get(key);
      if (prev !== undefined && prev <= g) continue;
      closed.set(key, g);
      push(target, vel, g, cur.first, false);
    }
  }

  // Оптимальный корень: с минимальной точной длиной плана (при равенстве — меньший
  // индекс, детерминизм). Если ни один план не достиг финиша в бюджете — фронтир-
  // fallback (ветка с минимальным f).
  let bestFirst = fallbackFirst;
  if (rootPlan.size > 0) {
    let bestLen = Infinity;
    rootPlan.forEach((len, i) => {
      if (len < bestLen) {
        bestLen = len;
        bestFirst = i;
      }
    });
  }

  // Пул для расталкивания: корню с точным планом — его длина; корню без плана
  // (ветки слились в closed или не дотянули) — оценка снизу 1 + navAt/vref в тех же
  // «ходах», чтобы годные ходы вперёд тоже попадали в пул (иначе A* решителен, пул
  // беден, и боты бунчатся). Аварийные/назад — большой штраф, вне пула.
  const rootSet = new Set(rootIdx);
  const scored = open.map((c, i) => {
    if (!rootSet.has(i)) return { c, score: 1e5 };
    const pl = rootPlan.get(i);
    if (pl !== undefined) return { c, score: pl };
    return { c, score: 1 + navAt(nav, c.target) / plan.vref };
  });
  return { best: open[bestFirst], terminal: false, scored };
}
