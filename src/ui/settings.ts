// Лист-модалка настроек правил заезда: управляемость машины (пресеты Реалистичная/
// Классическая или ручная «Своя» с тремя ползунками разгон/тормоза/маневр и живым
// предпросмотром облака ходов), тип штрафа за вылет, строгость динамической формулы,
// размер статического штрафа и лимит времени на ход (только онлайн). Владеет своими
// DOM-элементами; текущие правила держит вызывающий — сюда
// они приходят копией, а изменения уезжают через onChange.

import { Rules, Drive } from '../model/game';
import { reachableTargets } from '../model/turns';
import {
  CRASH_EXPONENT_STANDARD,
  CRASH_EXPONENT_STRICT,
  DRIVE_PRESETS,
  DRIVE_MIN,
  DRIVE_MAX,
  DRIVE_STEP,
} from '../config';
import { strings } from '../strings';
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
const maneuverSlider = document.getElementById('maneuverSlider') as HTMLInputElement;
const accelValue = document.getElementById('accelValue')!;
const brakeValue = document.getElementById('brakeValue')!;
const maneuverValue = document.getElementById('maneuverValue')!;
const drivePreview = document.getElementById('drivePreview') as HTMLCanvasElement;
const penaltyType = document.getElementById('penaltyType')!;
const exponentRow = document.getElementById('exponentRow')!;
const exponentType = document.getElementById('exponentType')!;
const staticRow = document.getElementById('staticRow')!;
const staticSlider = document.getElementById('staticSlider') as HTMLInputElement;
const staticTurnsValue = document.getElementById('staticTurnsValue')!;
const turnLimitRow = document.getElementById('turnLimitRow')!;
const turnLimitType = document.getElementById('turnLimitType')!;

type DriveMode = 'realistic' | 'classic' | 'custom';
type SettingsTab = 'drive' | 'rules';

/** Показатель степени, соответствующий выбору сегмента строгости. */
const exponentOf = (kind: string): number =>
  kind === 'strict' ? CRASH_EXPONENT_STRICT : CRASH_EXPONENT_STANDARD;

/** Совпадает ли drive с готовым пресетом (все три полуоси равны его значениям). */
const isPreset = (d: Drive, p: Drive): boolean =>
  d.accel === p.accel && d.brake === p.brake && d.maneuver === p.maneuver;

/** Режим управляемости по значениям drive: совпал с пресетом — его имя, иначе «Своя». */
function driveModeOf(d: Drive): DriveMode {
  if (isPreset(d, DRIVE_PRESETS.realistic)) return 'realistic';
  if (isPreset(d, DRIVE_PRESETS.classic)) return 'classic';
  return 'custom';
}

// Рабочая копия правил (мутируется контролами) и колбэк наружу — задаются при
// открытии. mode — какой сегмент управляемости показан (локально, в Rules не хранится:
// в Rules едет только числовой drive). online — показывать ли строку лимита времени.
let rules: Rules;
let mode: DriveMode = 'realistic';
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
  if (!custom) {
    driveExplain.textContent =
      mode === 'realistic'
        ? strings.settings.driveExplainRealistic
        : strings.settings.driveExplainClassic;
  }
  accelSlider.value = String(rules.drive.accel);
  brakeSlider.value = String(rules.drive.brake);
  maneuverSlider.value = String(rules.drive.maneuver);
  accelValue.textContent = String(rules.drive.accel);
  brakeValue.textContent = String(rules.drive.brake);
  maneuverValue.textContent = String(rules.drive.maneuver);
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

/**
 * Живой предпросмотр облака доступных ходов для текущего drive. Берём
 * репрезентативное состояние — болид едет вправо со скоростью 3, чтобы анизотропия
 * (нос вперёд от разгона, ширина от маневра, глубина назад от тормозов) была видна, —
 * и рисуем те же цели, что даст reachableTargets в игре (без дублирования модели).
 */
function drawPreview(): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = drivePreview.clientWidth || 240;
  const cssH = drivePreview.clientHeight || 150;
  drivePreview.width = Math.round(cssW * dpr);
  drivePreview.height = Math.round(cssH * dpr);
  const ctx = drivePreview.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pos = { x: 0, y: 0 };
  const vel = { x: 3, y: 0 };
  const coast = { x: pos.x + vel.x, y: pos.y + vel.y };
  const cells = reachableTargets(pos, vel, rules.drive);

  // Рамка обзора: облако + болид + точка наката, с полем в 1 клетку.
  let minX = pos.x;
  let maxX = pos.x;
  let minY = pos.y;
  let maxY = pos.y;
  for (const c of [...cells, coast]) {
    minX = Math.min(minX, c.x);
    maxX = Math.max(maxX, c.x);
    minY = Math.min(minY, c.y);
    maxY = Math.max(maxY, c.y);
  }
  minX -= 1;
  maxX += 1;
  minY -= 1;
  maxY += 1;
  const cols = maxX - minX;
  const rows = maxY - minY;
  const cell = Math.min(cssW / (cols || 1), cssH / (rows || 1));
  const ox = (cssW - cols * cell) / 2 - minX * cell;
  const oy = (cssH - rows * cell) / 2 - minY * cell;
  const X = (gx: number) => ox + gx * cell;
  const Y = (gy: number) => oy + gy * cell;

  // Бледная сетка узлов.
  ctx.fillStyle = '#cfc8b6';
  for (let gy = minY; gy <= maxY; gy++) {
    for (let gx = minX; gx <= maxX; gx++) {
      ctx.beginPath();
      ctx.arc(X(gx), Y(gy), 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Контур эллипса сцепления вокруг точки наката — видно связь полуосей (разгон/
  // тормоза/маневр) с формой облака. Две полудуги: перёд accel×maneuver, зад
  // brake×maneuver (как в drawDriveArea на поле).
  {
    const phi = Math.atan2(vel.y, vel.x);
    const ecx = X(coast.x);
    const ecy = Y(coast.y);
    const man = rules.drive.maneuver * cell;
    ctx.beginPath();
    ctx.ellipse(ecx, ecy, rules.drive.accel * cell, man, phi, -Math.PI / 2, Math.PI / 2);
    ctx.ellipse(
      ecx,
      ecy,
      rules.drive.brake * cell,
      man,
      phi,
      Math.PI / 2,
      (3 * Math.PI) / 2,
    );
    ctx.closePath();
    ctx.fillStyle = 'rgba(10, 138, 79, 0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(10, 138, 79, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // Стрелка инерции: болид → точка наката.
  ctx.strokeStyle = '#a49c86';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(pos.x), Y(pos.y));
  ctx.lineTo(X(coast.x), Y(coast.y));
  ctx.stroke();
  // Доступные цели хода.
  ctx.fillStyle = '#0a8a4f';
  for (const c of cells) {
    ctx.beginPath();
    ctx.arc(X(c.x), Y(c.y), Math.max(2.5, cell * 0.16), 0, Math.PI * 2);
    ctx.fill();
  }
  // Болид (текущая позиция).
  ctx.fillStyle = '#4a4636';
  ctx.beginPath();
  ctx.arc(X(pos.x), Y(pos.y), 3, 0, Math.PI * 2);
  ctx.fill();
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
  for (const el of [accelSlider, brakeSlider, maneuverSlider]) {
    el.min = String(DRIVE_MIN);
    el.max = String(DRIVE_MAX);
    el.step = String(DRIVE_STEP);
  }
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
      // Пресеты задают числа; «Своя» стартует от «Реалистичной» — ползунки
      // открываются на её значениях, дальше правь как хочешь.
      if (mode === 'classic') rules.drive = { ...DRIVE_PRESETS.classic };
      else rules.drive = { ...DRIVE_PRESETS.realistic };
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
  bindDrive(maneuverSlider, 'maneuver');
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
