// Лист-модалка настроек правил заезда: управляемость машины (пресеты Спорткар/GT/F1/
// Классическая или ручная «Своё» с ползунками разгон/тормоза/хват/прижим и живым
// предпросмотром облака ходов), тип штрафа за вылет, строгость динамической формулы,
// размер статического штрафа и лимит времени на ход (только онлайн). Владеет своими
// DOM-элементами; текущие правила держит вызывающий — сюда
// они приходят копией, а изменения уезжают через onChange.

import { Rules, Drive } from '../model/game';
import { reachableTargets, aeroFactor } from '../model/turns';
import {
  CRASH_EXPONENT_STANDARD,
  CRASH_EXPONENT_STRICT,
  DRIVE_PRESETS,
  DRIVE_MIN,
  DRIVE_MAX,
  DRIVE_STEP,
  DOWNFORCE_MIN,
  DOWNFORCE_MAX,
  DOWNFORCE_STEP,
  KMH_PER_CELL,
} from '../config';
import { strings } from '../i18n';
import { bindTap, openSheet } from './dom';

const sheet = document.getElementById('settingsSheet')!;
const settingsTabs = document.getElementById('settingsTabs')!;
const driveTab = document.getElementById('driveTab')!;
const rulesTab = document.getElementById('rulesTab')!;
const driveMode = document.getElementById('driveMode')!;
const driveExplain = document.getElementById('driveExplain')!;
const driveSliders = document.getElementById('driveSliders')!;
const accelSlider = document.getElementById('accelSlider') as HTMLInputElement;
const brakeSlider = document.getElementById('brakeSlider') as HTMLInputElement;
const gripSlider = document.getElementById('gripSlider') as HTMLInputElement;
const downforceSlider = document.getElementById('downforceSlider') as HTMLInputElement;
const accelValue = document.getElementById('accelValue')!;
const brakeValue = document.getElementById('brakeValue')!;
const gripValue = document.getElementById('gripValue')!;
const downforceValue = document.getElementById('downforceValue')!;
const drivePreview = document.getElementById('drivePreview') as HTMLCanvasElement;
const penaltyType = document.getElementById('penaltyType')!;
const exponentRow = document.getElementById('exponentRow')!;
const exponentType = document.getElementById('exponentType')!;
const staticRow = document.getElementById('staticRow')!;
const staticSlider = document.getElementById('staticSlider') as HTMLInputElement;
const staticTurnsValue = document.getElementById('staticTurnsValue')!;
const turnLimitRow = document.getElementById('turnLimitRow')!;
const turnLimitType = document.getElementById('turnLimitType')!;

type DrivePreset = keyof typeof DRIVE_PRESETS;
type DriveMode = DrivePreset | 'custom';
type SettingsTab = 'drive' | 'rules';

/** Показатель степени, соответствующий выбору сегмента строгости. */
const exponentOf = (kind: string): number =>
  kind === 'strict' ? CRASH_EXPONENT_STRICT : CRASH_EXPONENT_STANDARD;

/** Совпадает ли drive с готовым пресетом (все четыре оси равны его значениям). */
const isPreset = (d: Drive, p: Drive): boolean =>
  d.accel === p.accel &&
  d.brake === p.brake &&
  d.grip === p.grip &&
  d.downforce === p.downforce;

/** Режим управляемости по значениям drive: совпал с пресетом — его имя, иначе «Своё».
 *  Перебор по DRIVE_PRESETS — новые пресеты подхватываются автоматически. */
function driveModeOf(d: Drive): DriveMode {
  for (const [name, p] of Object.entries(DRIVE_PRESETS)) {
    if (isPreset(d, p)) return name as DrivePreset;
  }
  return 'custom';
}

// Рабочая копия правил (мутируется контролами) и колбэк наружу — задаются при
// открытии. mode — какой сегмент управляемости показан (локально, в Rules не хранится:
// в Rules едет только числовой drive). online — показывать ли строку лимита времени.
let rules: Rules;
let mode: DriveMode = 'sports';
let onChange: ((r: Rules) => void) | null = null;
let online = false;
// Какая вкладка листа открыта («Управляемость»/«Правила»). Локально, в Rules не хранится.
let activeTab: SettingsTab = 'drive';

/** Показать активную вкладку: переключить видимость групп и подсветку кнопок-табов. */
function applyTab(): void {
  driveTab.hidden = activeTab !== 'drive';
  rulesTab.hidden = activeTab !== 'rules';
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.tab === activeTab);
  });
}

/** Обновить вид контролов под текущие rules (активные сегменты, значения, видимость строк). */
function render(): void {
  applyTab();
  driveMode.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.mode === mode);
  });
  // Для пресетов — пояснение, для «Своей» — ползунки. Предпросмотр виден всегда.
  const custom = mode === 'custom';
  driveSliders.hidden = !custom;
  driveExplain.hidden = custom;
  if (mode !== 'custom') {
    const explain: Record<DrivePreset, string> = {
      sports: strings.settings.driveExplainSports,
      gt: strings.settings.driveExplainGt,
      f1: strings.settings.driveExplainF1,
      classic: strings.settings.driveExplainClassic,
    };
    driveExplain.textContent = explain[mode];
  }
  accelSlider.value = String(rules.drive.accel);
  brakeSlider.value = String(rules.drive.brake);
  gripSlider.value = String(rules.drive.grip);
  downforceSlider.value = String(rules.drive.downforce);
  accelValue.textContent = String(rules.drive.accel);
  brakeValue.textContent = String(rules.drive.brake);
  gripValue.textContent = String(rules.drive.grip);
  downforceValue.textContent = String(rules.drive.downforce);
  drawPreview();

  penaltyType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.penalty === rules.penalty);
  });
  exponentType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle(
      'seg__btn--active',
      exponentOf(btn.dataset.exponent!) === rules.dynamicExponent,
    );
  });
  turnLimitRow.hidden = !online;
  turnLimitType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle(
      'seg__btn--active',
      Number(btn.dataset.limit) === rules.turnLimitMs,
    );
  });
  const dynamic = rules.penalty === 'dynamic';
  exponentRow.hidden = !dynamic;
  staticRow.hidden = dynamic;
  staticSlider.value = String(rules.staticTurns);
  staticTurnsValue.textContent = String(rules.staticTurns);
}

/** Скорости (клетки/ход) для предпросмотра облака: 0.5 / 1 / 1.5 × DOWNFORCE_VREF
 *  (низкая ≈ чистая механика, средняя = референсная скорость прижима, высокая — прижим
 *  в полную силу). В км/ч (× KMH_PER_CELL): 150 / 300 / 450. */
const PREVIEW_SPEEDS = [3, 6, 9] as const;

/**
 * Живой предпросмотр облака доступных ходов для текущего drive. Рисуем облако на
 * нескольких скоростях (PREVIEW_SPEEDS), сведённых к общей точке наката: с ростом
 * скорости аэродинамический прижим раздвигает боковой хват и торможение (aero растёт
 * как квадрат скорости), и облако распухает — то, чего не видно на одной скорости.
 * Точки тонированы по ярусу (насыщенные доступны с низкой скорости, бледные добавляет
 * прижим), у контуров — подписи км/ч. downforce = 0 → форма от скорости не зависит,
 * показываем одно облако. Цели берём из reachableTargets — без дублирования модели.
 */
function drawPreview(): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = drivePreview.clientWidth || 240;
  const cssH = drivePreview.clientHeight || 190;
  drivePreview.width = Math.round(cssW * dpr);
  drivePreview.height = Math.round(cssH * dpr);
  const ctx = drivePreview.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { accel, brake, grip, downforce } = rules.drive;
  // downforce = 0 → aero ≡ 1 на любой скорости, облако не растёт: одна скорость (без подписей).
  const showSpeeds = downforce > 0;
  const speeds = showSpeeds ? [...PREVIEW_SPEEDS] : [PREVIEW_SPEEDS[0]];

  // Слой на каждую скорость: смещения a = target − C (клетки относительно ОБЩЕЙ точки
  // наката) + эффективные полуоси эллипса (перёд = accel, прижим его не трогает).
  const layers = speeds.map((v) => {
    const aero = aeroFactor(downforce, v);
    const off = reachableTargets({ x: 0, y: 0 }, { x: v, y: 0 }, rules.drive).map(
      (c) => ({
        x: c.x - v,
        y: c.y,
      }),
    );
    return { v, aero, back: brake * aero, side: grip * aero, off };
  });

  // Универсум точек (объединение по всем скоростям) + ярус первого появления.
  const tierOf = new Map<string, number>();
  layers.forEach((l, i) => {
    for (const o of l.off) {
      const k = o.x + ',' + o.y;
      if (!tierOf.has(k)) tierOf.set(k, i);
    }
  });
  const points = [...tierOf].map(([k, tier]) => {
    const [x, y] = k.split(',').map(Number);
    return { x, y, tier };
  });

  // Рамка обзора: bbox облака и контуров (+поле; сверху больше — под верхнюю подпись).
  const maxBack = Math.max(...layers.map((l) => l.back));
  const maxSide = Math.max(...layers.map((l) => l.side));
  let minX = -maxBack;
  let maxX = accel;
  let minY = -maxSide;
  let maxY = maxSide;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  minX -= 0.8;
  maxX += 0.8;
  minY -= showSpeeds ? 1.6 : 0.8;
  maxY += 0.8;
  const cols = maxX - minX;
  const rows = maxY - minY;
  const cell = Math.min(cssW / (cols || 1), cssH / (rows || 1));
  const ox = (cssW - cols * cell) / 2 - minX * cell;
  const oy = (cssH - rows * cell) / 2 - minY * cell;
  const X = (gx: number) => ox + gx * cell;
  const Y = (gy: number) => oy + gy * cell;
  const cx = X(0);
  const cy = Y(0); // общая точка наката (a = 0)

  // Бледная сетка узлов.
  ctx.fillStyle = '#cfc8b6';
  for (let gy = Math.ceil(minY); gy <= Math.floor(maxY); gy++) {
    for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx++) {
      ctx.beginPath();
      ctx.arc(X(gx), Y(gy), 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Стрелка направления: слева в точку наката — эллипс асимметричен (перёд разгон, зад тормоз).
  ctx.strokeStyle = '#a49c86';
  ctx.fillStyle = '#a49c86';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(minX + 0.4), cy);
  ctx.lineTo(cx - 5, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy);
  ctx.lineTo(cx - 11, cy - 4);
  ctx.lineTo(cx - 11, cy + 4);
  ctx.closePath();
  ctx.fill();

  // Контуры сцепления (от большой скорости к малой — меньший поверх). Полуэллипс:
  // перёд accel, зад back, вбок side.
  const traceEllipse = (back: number, side: number): void => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, accel * cell, side * cell, 0, -Math.PI / 2, Math.PI / 2);
    ctx.ellipse(cx, cy, back * cell, side * cell, 0, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  };
  const strokeA = [0.6, 0.5, 0.42];
  const strokeW = [1.8, 1.6, 1.4];
  for (let i = layers.length - 1; i >= 0; i--) {
    traceEllipse(layers[i].back, layers[i].side);
    ctx.fillStyle = 'rgba(10, 138, 79, 0.05)';
    ctx.fill();
    ctx.strokeStyle = `rgba(10, 138, 79, ${strokeA[i]})`;
    ctx.lineWidth = strokeW[i];
    ctx.stroke();
  }

  // Точки-кандидаты, тонированные по ярусу (насыщенные доступны с низкой скорости,
  // бледные добавил прижим на скорости).
  const dotAlpha = [0.85, 0.5, 0.28];
  const dotR = Math.max(2.2, cell * 0.14);
  ctx.fillStyle = '#0a8a4f';
  for (const p of points) {
    if (p.x === 0 && p.y === 0) continue; // накат рисуем кольцом
    ctx.globalAlpha = dotAlpha[p.tier] ?? 0.28;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Точка наката — кольцо.
  ctx.strokeStyle = '#4a4636';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(cx, cy, dotR + 1, 0, Math.PI * 2);
  ctx.stroke();

  // Подписи км/ч у верхней вершины каждого контура (только когда прижим растит облако —
  // иначе форма от скорости не зависит и подпись вводила бы в заблуждение). Раскладываем
  // сверху вниз с гарантированным зазором, чтобы близкие контуры (напр. GT) не слиплись.
  if (showSpeeds) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = '600 10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.lineJoin = 'round';
    let prevLy = -Infinity;
    for (const l of [...layers].sort((a, b) => b.side - a.side)) {
      const ly = Math.max(Y(-l.side) - 3, prevLy + 12);
      prevLy = ly;
      const label = `${l.v * KMH_PER_CELL} ${strings.race.speedUnit}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fbf9f1';
      ctx.strokeText(label, cx, ly);
      ctx.fillStyle = '#0a8a4f';
      ctx.fillText(label, cx, ly);
    }
  }
}

/** Применить изменение правил: перерисовать и уведомить вызывающего. */
function commit(): void {
  render();
  onChange?.(rules);
}

/**
 * Открыть настройки. current — текущие правила (копируем: изменения сразу отдаём
 * через onChange, чужой объект не трогаем; drive копируем глубоко — его мутируют
 * ползунки). isOnline — сетевой заезд: тогда показываем строку лимита времени.
 */
export function openSettings(
  current: Rules,
  isOnline: boolean,
  onChangeCb: (r: Rules) => void,
): void {
  rules = { ...current, drive: { ...current.drive } };
  mode = driveModeOf(rules.drive);
  online = isOnline;
  onChange = onChangeCb;
  activeTab = 'drive'; // лист всегда открывается на «Управляемости»
  render();
  openSheet(sheet);
  // Первый render шёл при скрытом листе (нулевая ширина канваса) — перерисуем превью,
  // когда лист виден и известна фактическая ширина.
  requestAnimationFrame(() => drawPreview());
}

/** Навесить обработчики сегментов и ползунков (один раз при инициализации панели). */
export function bindSettings(): void {
  for (const el of [accelSlider, brakeSlider, gripSlider]) {
    el.min = String(DRIVE_MIN);
    el.max = String(DRIVE_MAX);
    el.step = String(DRIVE_STEP);
  }
  // Прижим — своя шкала (безразмерный коэффициент 0..1.5), не как механические оси.
  downforceSlider.min = String(DOWNFORCE_MIN);
  downforceSlider.max = String(DOWNFORCE_MAX);
  downforceSlider.step = String(DOWNFORCE_STEP);
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      activeTab = btn.dataset.tab as SettingsTab;
      applyTab();
      // Возврат на «Управляемость»: канвас мог лежать скрытым (нулевая ширина) —
      // перерисуем превью, когда он снова видим (как в openSettings).
      if (activeTab === 'drive') requestAnimationFrame(() => drawPreview());
    });
  });
  // Кнопки-подсказки «?»: тап раскрывает/прячет пояснение в своей строке настройки.
  sheet.querySelectorAll<HTMLButtonElement>('.setting__help').forEach((btn) => {
    const hint = btn.closest('.setting')!.querySelector<HTMLElement>('.setting__hint')!;
    bindTap(btn, () => {
      hint.hidden = !hint.hidden;
      btn.setAttribute('aria-expanded', String(!hint.hidden));
    });
  });
  driveMode.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      mode = btn.dataset.mode as DriveMode;
      // Пресет задаёт числа; «Своё» оставляет текущий drive (ползунки открываются на
      // его значениях, дальше правь как хочешь).
      const preset = DRIVE_PRESETS[mode as DrivePreset];
      if (preset) rules.drive = { ...preset };
      commit();
    });
  });
  const bindDrive = (el: HTMLInputElement, axis: keyof Drive): void => {
    el.addEventListener('input', () => {
      rules.drive[axis] = Number(el.value);
      mode = 'custom'; // правка ползунком = ручной режим
      commit();
    });
  };
  bindDrive(accelSlider, 'accel');
  bindDrive(brakeSlider, 'brake');
  bindDrive(gripSlider, 'grip');
  bindDrive(downforceSlider, 'downforce');
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
  turnLimitType.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      rules.turnLimitMs = Number(btn.dataset.limit);
      commit();
    });
  });
}
