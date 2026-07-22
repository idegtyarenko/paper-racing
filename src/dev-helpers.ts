// Dev-only тест-хелперы (`window.__pr`). Ручное прохождение мастера редактора
// (нарисовать петлю → кромки → финиш → направление → режим → игроки) при браузерной
// валидации сжигает уйму шагов и токенов. Эти хелперы прыгают сразу в нужное
// состояние на готовой трассе и возвращают дешёвый JSON-снимок — читать состояние
// можно одним вызовом вместо цепочки скриншотов.
//
// Модуль подключается динамическим импортом только под `import.meta.env.DEV`
// (см. `main.ts`). В ПРОД-БАНДЛ НЕ ПОПАДАЕТ: Vite заменяет `import.meta.env.DEV` на
// `false`, ветка с импортом удаляется как мёртвый код, и чанк не создаётся —
// проверяется `npm run build` + grep по dist. Пользователю не виден.

import { AppState } from './app-state';
import { setLocale as applyLocale, type LocaleCode } from './i18n';
import { Track, finalizeTrack, clipFinishLine } from './model/track';
import { editorFromTrack } from './model/editor';
import { Candidate, isFinished, WIN_CROSSINGS } from './model/game';
import { Difficulty } from './model/ai';
import { worldToScreen } from './view/camera';
import * as vp from './view/viewport';
import * as input from './view/input';

/** Зависимости из `main.ts`, которые хелперы дёргают по ссылке — оркестрация
 *  остаётся приватной в main.ts, наружу отдаём ровно нужное. */
export interface DevHelperDeps {
  S: AppState;
  canvas: HTMLCanvasElement;
  startRace: (humans: number, bots: number, difficulty: Difficulty) => void;
  refreshCands: () => void;
  updateUI: () => void;
  redraw: () => void;
  candOwner: () => number;
  cancelAiMove: () => void;
  commitMove: (cand: Candidate) => void;
  myTurn: () => boolean;
}

export function installDevHelpers(deps: DevHelperDeps): void {
  const {
    S,
    canvas,
    startRace,
    refreshCands,
    updateUI,
    redraw,
    candOwner,
    cancelAiMove,
    commitMove,
    myTurn,
  } = deps;

  // Готовая прямоугольная трасса-«бублик»: дорога — рамка между внешним и
  // внутренним прямоугольниками, финиш поперёк НИЖНЕЙ прямой, гонка в +x.
  // Финиш строится так же, как в редакторе, — коротким штрихом поперёк дороги,
  // обрезанным по кромкам через `clipFinishLine` (концы вынесены за кромки на
  // 0.25). Так фикстура остаётся реально рисуемой мастером: линия пересекает всю
  // ширину дороги от кромки до кромки (y=0 внешняя → y=8 внутренняя), а не
  // обрывается посередине, как раньше на ЛЕВОЙ прямой (x=6, где дорога тянется
  // до y=24, а линия доходила лишь до y=8).
  const devTrack = (): Track => {
    const outer = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 24 },
      { x: 0, y: 24 },
    ];
    const inner = [
      { x: 8, y: 8 },
      { x: 32, y: 8 },
      { x: 32, y: 16 },
      { x: 8, y: 16 },
    ];
    const fin = clipFinishLine({ x: 20, y: 3 }, { x: 20, y: 5 }, outer, inner);
    if ('error' in fin) throw new Error(`dev finish invalid: ${fin.error}`);
    const res = finalizeTrack(outer, inner, fin.finish, { x: 1, y: 0 });
    if ('error' in res) throw new Error(`dev track invalid: ${res.error}`);
    return res.track;
  };
  // Дешёвый снимок ключевого состояния для ассертов без скриншотов.
  const snap = () => ({
    phase: S.phase,
    gamePhase: S.game?.phase ?? null,
    current: S.game?.current ?? null,
    players:
      S.game?.players.map((p) => ({
        name: p.name,
        bot: p.bot ?? null,
        place: p.place,
        pos: p.pos,
        vel: p.vel,
        crossings: p.crossings,
        finished: isFinished(p),
      })) ?? null,
    lastLocalRace: S.lastLocalRace,
    // Предвыбор: место-владелец веера, число кандидатов и текущая наметка.
    candSeat: candOwner(),
    candsCount: S.cands?.length ?? null,
    pending: S.pending?.target ?? null,
    hover: input.getHover()?.target ?? null,
  });
  (window as unknown as Record<string, unknown>).__pr = {
    /** Тест-переключатель языка: пишет выбор в localStorage и перезагружает. Для
     *  проверки локалей без UI (то же делает `?lang=en|ru|be` в URL). */
    setLocale(code: LocaleCode) {
      applyLocale(code);
    },
    /** Готовая трасса + сразу локальная гонка: humans людей, bots ботов. */
    race(humans = 1, bots = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      return snap();
    },
    /** Живая гонка, придвинутая к финишу: всем (людям и ботам) выставляется
     *  crossings = WIN−laps, позиции не трогаем (болиды остаются на стартовой
     *  решётке за линией). При laps=1 первое же пересечение финиша побеждает —
     *  удобно доиграть концовку вручную (расстановка мест, заморозка порядка,
     *  переход в phase='over', win-экран), не наматывая круги. */
    nearFinish(humans = 1, bots = 1, laps = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(humans, bots, difficulty);
      for (const p of S.game!.players) p.crossings = WIN_CROSSINGS - laps;
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** Гонка, где человек (seat 0) в одном ходе от победы: crossings = WIN−1, стоит
     *  на нижней прямой перед линией финиша (x=20) с инерцией (2,0) сквозь неё
     *  (18→20); соперники убраны на верхнюю прямую, чтобы не мешать и не
     *  финишировать. После tapAccel(0,0) человек побеждает, но place ещё null (идёт
     *  доигровка раунда) — это и есть «окно финиша», в котором финишёру НЕ должен
     *  предлагаться ход. */
    raceAtWin(bots = 1, difficulty: Difficulty = 'medium') {
      S.raceTrack = devTrack();
      startRace(1, bots, difficulty);
      const h = S.game!.players[0];
      h.crossings = WIN_CROSSINGS - 1;
      h.pos = { x: 18, y: 4 };
      h.vel = { x: 2, y: 0 };
      for (let i = 1; i < S.game!.players.length; i++) {
        S.game!.players[i].pos = { x: 16, y: 20 }; // верхняя прямая, не блокируют финиш
      }
      refreshCands();
      updateUI();
      redraw();
      return snap();
    },
    /** Готовая трасса → редактор на финальном шаге `ready` (минуя рисование): та же
     *  общая canvas-поверхность, что в гонке, плюс редакторский оверлей. Для
     *  визуальной проверки полотна/кромок в режиме edit без прохождения мастера. */
    toEdit() {
      S.editor = editorFromTrack(devTrack());
      S.phase = 'edit';
      cancelAiMove();
      updateUI();
      redraw();
      return snap();
    },
    /** Готовая трасса → экран выбора режима (минуя рисование). */
    toMode() {
      S.raceTrack = devTrack();
      S.playersReturn = 'edit';
      cancelAiMove();
      S.phase = 'modeSelect';
      updateUI();
      redraw();
      return snap();
    },
    /** Обнулить сохранённый локальный состав (эмуляция «после онлайн-гонки»,
     *  когда рематч одним тапом недоступен и кнопка «Рематч» прячется). */
    clearLastRace() {
      S.lastLocalRace = null;
      updateUI();
      return snap();
    },
    /** Снимок состояния приложения для ассертов. */
    state: snap,
    /**
     * Тап по кандидату с ускорением (ax, ay) у места-владельца веера — тем же
     * решением, что input.endGesture: в чужой ход это наметка (setPending), в свой —
     * коммит. Позволяет прогнать предвыбор без синтетики pointer-событий по canvas.
     */
    tapAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0 || !S.cands) return snap();
      const p = S.game!.players[seat];
      const tx = p.pos.x + p.vel.x + ax;
      const ty = p.pos.y + p.vel.y + ay;
      const c = S.cands.find((k) => k.target.x === tx && k.target.y === ty);
      if (!c) return snap();
      if (!myTurn() && seat >= 0) {
        S.pending = c; // наметка (как setPending в input-deps)
        redraw();
      } else {
        commitMove(c);
      }
      return snap();
    },
    /** Подтвердить наметку в свой ход (эквивалент кнопки «Газу!»). */
    confirm() {
      if (S.pending && myTurn()) commitMove(S.pending);
      return snap();
    },
    /** Синтетический ховер мышью над кандидатом с ускорением (ax, ay) — проверить,
     *  что наведение переживает чужой ход (reaimHover). */
    hoverAccel(ax: number, ay: number) {
      const seat = candOwner();
      if (seat < 0) return snap();
      const p = S.game!.players[seat];
      const target = { x: p.pos.x + p.vel.x + ax, y: p.pos.y + p.vel.y + ay };
      const scr = worldToScreen(vp.camera(), target);
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerType: 'mouse',
          clientX: r.left + scr.x,
          clientY: r.top + scr.y,
          bubbles: true,
        }),
      );
      return snap();
    },
    /** Прогнать refreshCands+redraw — эмуляция входящего чужого хода без смены стейта. */
    refresh() {
      refreshCands();
      redraw();
      return snap();
    },
  };
}
