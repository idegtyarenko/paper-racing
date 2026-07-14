// Тесты ИИ: навигационное поле (BFS до финиша) и выбор хода ботом.
//
// Трасса — то же прямоугольное кольцо, что в test-fixtures, но финиш на середине
// нижней прямой (x=20, от внешней стенки y=0 до внутренней y=8): там линия
// перегораживает дорогу от стенки до стенки, как строит clipFinishLine в игре.
// Штатный финиш фикстуры (x=6) стоит в левом коридоре, где внутренней стенки
// нет, — его конец можно легально объехать, и семантика круга ломается.
// Гонка в +x: sideOfFinish(p) = p.x − 20, старты — слева от линии.

import { describe, it, expect } from 'vitest';
import { chooseMove, Difficulty } from './ai';
import { buildNavField, navAt } from './nav';
import { candidates, applyMove, coastMove } from './turns';
import { GameState, Player, computeOutcome, WIN_CROSSINGS } from './game';
import { Track, key, unkey, finalizeTrack } from './track';
import { Vec, dist } from '../geometry';
import { OUTER, INNER, gameOn } from './test-fixtures';

const FIN_X = 20;

function aiTrack(): Track {
  // Концы линии продлены на 0.25 за стенки, как делает clipFinishLine: иначе
  // в полосе допуска у стенки остаётся щель, через которую можно «поднырнуть»
  // под конец линии без пересечения — и ИИ такую лазейку честно находит.
  const res = finalizeTrack(
    OUTER,
    INNER,
    { a: { x: FIN_X, y: -0.25 }, b: { x: FIN_X, y: 8.25 } },
    { x: 1, y: 0 },
  );
  if ('error' in res) throw new Error(`aiTrack fixture invalid: ${res.error}`);
  return res.track;
}

const track = aiTrack();
const nav = buildNavField(track);

/** Игрок в заданной точке с заданной скоростью (для синтетических состояний). */
function playerAt(pos: Vec, vel: Vec = { x: 0, y: 0 }): Player {
  return {
    name: 'p',
    color: '#000',
    pos: { ...pos },
    vel: { ...vel },
    trail: [],
    crashes: [],
    skipTurns: 0,
    crossings: 0,
    finishOvershoot: null,
    place: null,
    retired: false,
  };
}

/** Детерминированный rng-стаб: всегда одно значение. */
const rngConst = (v: number) => (): number => v;

describe('buildNavField', () => {
  it('покрывает все узлы дороги конечным расстоянием', () => {
    track.inside.forEach((k) => {
      expect(
        nav.dist.get(k),
        `нет расстояния для ${JSON.stringify(unkey(k))}`,
      ).toBeGreaterThan(0);
    });
  });

  it('сиды (dist=1) лежат строго за линией финиша', () => {
    let min = Infinity;
    nav.dist.forEach((d, k) => {
      min = Math.min(min, d);
      if (d === 1) expect(unkey(k).x).toBeLessThan(FIN_X);
    });
    expect(min).toBe(1);
  });

  it('клетка сразу за финишем едет в обход (≈ полный круг), а не назад', () => {
    const ahead = nav.dist.get(key(FIN_X + 1, 3))!;
    expect(ahead).toBeGreaterThan(nav.lap * 0.8);
  });

  it('расстояние монотонно убывает вдоль направления гонки', () => {
    // Нижняя прямая впереди линии: гонка в +x, дальше по кругу — ближе к финишу.
    expect(nav.dist.get(key(25, 3))!).toBeGreaterThan(nav.dist.get(key(35, 3))!);
    // Верхняя прямая: гонка в −x.
    expect(nav.dist.get(key(30, 20))!).toBeGreaterThan(nav.dist.get(key(10, 20))!);
    // За линией: чем ближе к финишу, тем меньше.
    expect(nav.dist.get(key(12, 3))!).toBeGreaterThan(nav.dist.get(key(18, 3))!);
  });
});

describe('navAt', () => {
  it('работает для дробных точек вне узлов дороги (полоса допуска)', () => {
    const v = navAt(nav, { x: 30.4, y: 0.1 });
    expect(v).toBeLessThan(nav.lap);
    // Близко к значению соседнего узла (с точностью до евклидова добора).
    expect(Math.abs(v - nav.dist.get(key(30, 1))!)).toBeLessThan(2.5);
  });

  it('глухой гравий (вне окна поиска) даёт консервативную длину круга', () => {
    expect(navAt(nav, { x: 200, y: 200 })).toBe(nav.lap);
  });

  // Регрессия: поле не должно «протекать» на соседний проход трассы через
  // тонкую перегородку. Кольцо с внутренней стенкой толщиной 2 (y∈[11,13]):
  // нижний коридор (у финиша, далеко «по кругу») и верхний («задняя прямая»,
  // близко к финишу) идут в ~3 клетках друг от друга. Точка в нижнем коридоре
  // над перегородкой евклидово-близка к дешёвому узлу верхнего коридора; без
  // проверки прямой видимости navAt хватал его минимум, и бот ехал в стену.
  it('не протекает сквозь тонкую перегородку между проходами', () => {
    const res = finalizeTrack(
      OUTER,
      [
        { x: 4, y: 11 },
        { x: 36, y: 11 },
        { x: 36, y: 13 },
        { x: 4, y: 13 },
      ],
      { a: { x: 6, y: -0.25 }, b: { x: 6, y: 11.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in res) throw new Error(`fixture invalid: ${res.error}`);
    const thinNav = buildNavField(res.track);

    // Узел верхнего коридора за перегородкой — честно дёшев (близко к финишу).
    const backStraight = navAt(thinNav, { x: 20, y: 14 });
    expect(backStraight).toBeLessThan(30);

    // Точка нижнего коридора у перегородки: до финиша ей ехать почти весь круг.
    // С прямой видимостью — честное большое значение (~58); при протечке через
    // стенку схлопывалось бы к дешёвому верхнему узлу (~24).
    const nearWall = navAt(thinNav, { x: 20, y: 10.5 });
    expect(nearWall).toBeGreaterThan(50);
    expect(nearWall).toBeGreaterThan(backStraight + 25);
  });
});

/** Прогнать гонку, где всеми местами управляет бот заданной сложности. */
function botRace(players: number, difficulty: Difficulty, maxTurns: number): GameState {
  const state = gameOn(track, players);
  const rng = rngConst(0.99); // без epsilon-случайности — детерминированный прогон
  for (let i = 0; i < maxTurns && state.phase === 'race'; i++) {
    const cand = chooseMove(state, nav, difficulty, rng);
    if (cand) applyMove(state, cand);
    else coastMove(state);
  }
  return state;
}

describe('chooseMove', () => {
  it('одиночный сложный бот проходит круг, ни разу не вылетев', () => {
    // Чистый инвариант безопасности у стен: соперник стоит на старте и пасует
    // (coastMove при нулевой скорости), трафика нет. Соперник не финиширует и не
    // сдаётся, поэтому гонка формально не кончается — проверяем, что бот сам
    // добрался до финиша (стал победителем и получил место 1) без аварий.
    const state = gameOn(track, 2);
    const rng = rngConst(0.99);
    for (let i = 0; i < 400 && state.winner === null; i++) {
      if (state.current === 0) {
        const cand = chooseMove(state, nav, 'hard', rng);
        if (cand) applyMove(state, cand);
        else coastMove(state);
      } else {
        coastMove(state);
      }
    }
    expect(state.winner).toBe(0);
    expect(state.players[0].place).toBe(1);
    expect(state.players[0].crashes).toHaveLength(0);
  });

  // Сила hard: A* минимизирует ЧИСЛО ХОДОВ (не длину пути), поэтому несёт скорость
  // через связки и проходит извилистую трассу заметно быстрее прежнего жадного бота.
  // Шпилька (два разворота на 180° вокруг тонкого языка) — где жадная внутренняя
  // линия особенно медленна. Порог с запасом над измеренным (~29); срабатывает,
  // если планировщик деградирует к «оптимизации пути».
  it('сложный бот проходит извилистую трассу за мало ходов (time-оптимум)', () => {
    const hp = finalizeTrack(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 20 },
        { x: 0, y: 20 },
      ],
      [
        { x: 4, y: 8 },
        { x: 36, y: 8 },
        { x: 36, y: 12 },
        { x: 4, y: 12 },
      ],
      { a: { x: 20, y: -0.25 }, b: { x: 20, y: 8.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in hp) throw new Error(`fixture invalid: ${hp.error}`);
    const hpNav = buildNavField(hp.track);
    const state = gameOn(hp.track, 2);
    state.players[1].retired = true; // соло: соперник не мешает
    const rng = rngConst(0.99);
    let moves = 0;
    for (let i = 0; i < 400 && state.winner === null; i++) {
      const cand = chooseMove(state, hpNav, 'hard', rng);
      if (cand) applyMove(state, cand);
      else coastMove(state);
      moves += 1;
    }
    expect(state.winner).toBe(0);
    expect(state.players[0].crashes).toHaveLength(0);
    expect(moves).toBeLessThanOrEqual(34);
  });

  it('сложные боты доигрывают гонку почти без аварий', () => {
    // В плотном трафике вынужденная авария возможна (соперники глубже первого
    // слоя не прогнозируются) — но должна оставаться редкостью.
    const state = botRace(4, 'hard', 400);
    expect(state.phase).toBe('over');
    expect(state.winner).not.toBeNull();
    const totalCrashes = state.players.reduce((s, p) => s + p.crashes.length, 0);
    expect(totalCrashes).toBeLessThanOrEqual(2);
  });

  it('лёгкие боты доигрывают гонку без дедлока (аварии допустимы)', () => {
    const state = botRace(4, 'easy', 800);
    expect(state.phase).toBe('over');
    expect(state.winner).not.toBeNull();
  });

  it('лёгкий бот держит мягкий потолок скорости', () => {
    // Длинная нижняя прямая, скорость уже на потолке (4): разгоняться дальше
    // выгодно по расстоянию, но штраф за превышение должен перевесить.
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 22, y: 4 };
    me.vel = { x: 4, y: 0 };
    state.players[1].pos = { x: 12, y: 22 }; // соперник не мешает
    const cand = chooseMove(state, nav, 'easy', rngConst(0.99))!;
    expect(dist(me.pos, cand.target)).toBeLessThanOrEqual(4);
  });

  it('никогда не возвращает blocked-кандидата', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 24, y: 3 };
    me.vel = { x: 1, y: 0 };
    state.players[1].pos = { x: 25, y: 3 }; // соперник прямо по курсу
    for (let i = 0; i < 20; i++) {
      const cand = chooseMove(state, nav, 'easy', rngConst(i / 20));
      expect(cand).not.toBeNull();
      expect(cand!.blocked).toBe(false);
    }
  });

  it('возвращает null при полном окружении (все 9 кандидатов blocked)', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 24, y: 3 };
    me.vel = { x: 2, y: 0 };
    // Все 9 целей (x∈25..27, y∈2..4) заняты соперниками — синтетический пат.
    state.players.length = 1;
    for (let y = 2; y <= 4; y++) {
      for (let x = 25; x <= 27; x++) state.players.push(playerAt({ x, y }));
    }
    expect(candidates(state).every((c) => c.blocked)).toBe(true);
    expect(chooseMove(state, nav, 'hard')).toBeNull();
  });

  it('на финишном ходе максимизирует заезд за линию', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.crossings = 1; // круг пройден, осталось финишное пересечение
    me.pos = { x: 17, y: 3 };
    me.vel = { x: 3, y: 0 }; // цели x∈19..21: пересечение на x=20 и глубже на x=21
    state.players[1].pos = { x: 3, y: 22 };
    const cand = chooseMove(state, nav, 'hard')!;
    expect(cand.target.x).toBe(21); // самый глубокий заезд за линию
  });

  it('при безвыходной аварии выбирает наименьший штраф', () => {
    const state = gameOn(track, 2);
    const me = state.players[0];
    me.pos = { x: 36, y: 3 };
    me.vel = { x: 6, y: 0 }; // цели x∈41..43 — все за внешней стенкой (x=40)
    state.players[1].pos = { x: 3, y: 22 };
    const cands = candidates(state);
    expect(cands.every((c) => c.crash)).toBe(true);
    const cand = chooseMove(state, nav, 'hard')!;
    const chosen = computeOutcome(track, state.rules, me.pos, cand.target);
    const minSkip = Math.min(
      ...cands.map((c) => computeOutcome(track, state.rules, me.pos, c.target).skipTurns),
    );
    expect(chosen.skipTurns).toBe(minSkip);
  });

  it('сложный бот детерминирован', () => {
    const state = gameOn(track, 3);
    const a = chooseMove(state, nav, 'hard')!;
    const b = chooseMove(state, nav, 'hard')!;
    expect(a.target).toEqual(b.target);
  });

  // Соперник не саботирует темп бота. Прежнее «расталкивание» (штраф за близость к
  // сопернику) заставляло бота уступать гоночную линию любому противнику и теряло
  // ~40% темпа (в пачке ~68 ходов против ~46 соло), из-за чего человек легко
  // отрывался даже 1-на-1. Теперь расталкивания нет: болиды обводят друг друга самим
  // поиском (blocked-ходы отсеяны, план строится в объезд), и в пачке идут почти
  // соло-темпом. Проверяем: лидер пачки укладывается около соло, все финишируют без
  // дедлока, и никто не едет против трассы.
  it('соперник не саботирует темп бота (в пачке ≈ соло)', () => {
    const wide = finalizeTrack(
      [
        { x: 0, y: 0 },
        { x: 60, y: 0 },
        { x: 60, y: 40 },
        { x: 0, y: 40 },
      ],
      [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 50, y: 30 },
        { x: 10, y: 30 },
      ],
      { a: { x: 30, y: -0.25 }, b: { x: 30, y: 10.25 } },
      { x: 1, y: 0 },
    );
    if ('error' in wide) throw new Error(`fixture invalid: ${wide.error}`);
    const wnav = buildNavField(wide.track);
    const rng = rngConst(0.37);

    // Соло: один бот (соперник снят) — эталон темпа.
    const s0 = gameOn(wide.track, 2);
    s0.players[1].retired = true;
    let soloMoves = 0;
    for (let i = 0; i < 600 && s0.winner === null; i++) {
      const c = chooseMove(s0, wnav, 'hard', rng);
      if (c) applyMove(s0, c);
      else coastMove(s0);
      soloMoves += 1;
    }
    expect(s0.winner).toBe(0);

    // Пачка из 4: личные ходы каждого до завершения круга + контроль заднего хода.
    const state = gameOn(wide.track, 4);
    const my = state.players.map(() => 0);
    const lap: (number | null)[] = state.players.map(() => null);
    let backward = 0;
    for (let i = 0; i < 1600 && state.phase === 'race'; i++) {
      const seat = state.current;
      const p = state.players[seat];
      if (p.place !== null || p.retired || p.skipTurns > 0) {
        coastMove(state);
        continue;
      }
      my[seat] += 1;
      const navBefore = navAt(wnav, p.pos);
      const crossBefore = p.crossings;
      const cand = chooseMove(state, wnav, 'hard', rng);
      if (cand) applyMove(state, cand);
      else coastMove(state);
      const sp = state.players[seat];
      if (lap[seat] === null && sp.crossings >= WIN_CROSSINGS) lap[seat] = my[seat];
      if (sp.crossings === crossBefore && sp.skipTurns === 0) {
        if (navAt(wnav, sp.pos) > navBefore + 3) backward += 1;
      }
    }
    expect(state.players.filter((q) => q.place !== null).length).toBe(4); // без дедлока
    expect(backward).toBe(0); // никто не едет против трассы
    const winnerMoves = Math.min(...lap.filter((x): x is number => x !== null));
    // Лидер пачки — около соло (не раздут вдвое, как при старом расталкивании).
    expect(winnerMoves).toBeLessThanOrEqual(soloMoves + 6);
  });
});
