// Race-rules settings sheet: car handling (Sports/GT/F1/Classic presets, or a
// manual "Custom" mode with accel/brake/grip/downforce sliders and a live
// preview of the reachable-moves cloud), crash-penalty type, dynamic-formula
// strictness, static-penalty size, and the per-turn time limit (online only).
// Owns its own DOM elements; the caller holds the actual rules — they arrive
// here as a copy, and changes are sent back out via onChange.

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

/** The exponent corresponding to the selected strictness segment. */
const exponentOf = (kind: string): number =>
  kind === 'strict' ? CRASH_EXPONENT_STRICT : CRASH_EXPONENT_STANDARD;

/** Whether drive matches a built-in preset (all four axes equal its values). */
const isPreset = (d: Drive, p: Drive): boolean =>
  d.accel === p.accel &&
  d.brake === p.brake &&
  d.grip === p.grip &&
  d.downforce === p.downforce;

/** Handling mode derived from drive values: the preset's name if it matches
 *  one, otherwise "Custom". Iterates over DRIVE_PRESETS, so new presets are
 *  picked up automatically. */
function driveModeOf(d: Drive): DriveMode {
  for (const [name, p] of Object.entries(DRIVE_PRESETS)) {
    if (isPreset(d, p)) return name as DrivePreset;
  }
  return 'custom';
}

// Working copy of the rules (mutated by the controls) and the outward
// callback — set when the sheet opens. mode is which handling segment is
// shown (kept locally, not stored in Rules: Rules only carries the numeric
// drive values). online controls whether the time-limit row is shown.
let rules: Rules;
let mode: DriveMode = 'sports';
let onChange: ((r: Rules) => void) | null = null;
let online = false;
// Which sheet tab is open ("Handling"/"Rules"). Kept locally, not stored in Rules.
let activeTab: SettingsTab = 'drive';

/** Show the active tab: toggle group visibility and the tab-button highlight. */
function applyTab(): void {
  driveTab.hidden = activeTab !== 'drive';
  rulesTab.hidden = activeTab !== 'rules';
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.tab === activeTab);
  });
}

/** Refresh the controls to match the current rules (active segments, values, row visibility). */
function render(): void {
  applyTab();
  driveMode.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    btn.classList.toggle('seg__btn--active', btn.dataset.mode === mode);
  });
  // Presets get an explanation; "Custom" gets sliders. The preview is always visible.
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

/** Speeds (cells/turn) for the preview cloud: 0.5 / 1 / 1.5 × DOWNFORCE_VREF
 *  (low ≈ pure mechanics, mid = the downforce reference speed, high = downforce
 *  at full strength). In km/h (× KMH_PER_CELL): 150 / 300 / 450. */
const PREVIEW_SPEEDS = [3, 6, 9] as const;

/**
 * Live preview of the reachable-moves cloud for the current drive settings. We
 * draw the cloud at several speeds (PREVIEW_SPEEDS), all aligned to a shared
 * coasting point: as speed increases, aerodynamic downforce widens both
 * lateral grip and braking (aero grows with the square of speed), so the
 * cloud swells — something a single-speed view wouldn't show. Points are
 * tinted by tier (saturated ones are reachable already at low speed, faded
 * ones are added by downforce), and the outlines carry km/h labels.
 * downforce = 0 → shape doesn't depend on speed, so we show a single cloud.
 * Targets come from reachableTargets — no duplicating the model.
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
  // downforce = 0 → aero ≡ 1 at any speed, so the cloud doesn't grow: a single speed (no labels).
  const showSpeeds = downforce > 0;
  const speeds = showSpeeds ? [...PREVIEW_SPEEDS] : [PREVIEW_SPEEDS[0]];

  // One layer per speed: offsets a = target − C (cells relative to the SHARED
  // coasting point) plus the effective ellipse semi-axes (front = accel, which
  // downforce leaves untouched).
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

  // The universe of points (union over all speeds) + the tier of first appearance.
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

  // Viewport frame: bbox of the cloud and outlines (+padding; more at the top, for the label above).
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
  const cy = Y(0); // the shared coasting point (a = 0)

  // Faint node grid.
  ctx.fillStyle = '#cfc8b6';
  for (let gy = Math.ceil(minY); gy <= Math.floor(maxY); gy++) {
    for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx++) {
      ctx.beginPath();
      ctx.arc(X(gx), Y(gy), 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Direction arrow: pointing left into the coasting point — the ellipse is
  // asymmetric (front is acceleration, back is braking).
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

  // Grip outlines (from high speed to low — the smaller one drawn on top).
  // Half-ellipse: front = accel, back = back, side = side.
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

  // Candidate points, tinted by tier (saturated ones are reachable already at
  // low speed, faded ones were added by downforce at speed).
  const dotAlpha = [0.85, 0.5, 0.28];
  const dotR = Math.max(2.2, cell * 0.14);
  ctx.fillStyle = '#0a8a4f';
  for (const p of points) {
    if (p.x === 0 && p.y === 0) continue; // the coasting point is drawn as a ring
    ctx.globalAlpha = dotAlpha[p.tier] ?? 0.28;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The coasting point — a ring.
  ctx.strokeStyle = '#4a4636';
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(cx, cy, dotR + 1, 0, Math.PI * 2);
  ctx.stroke();

  // km/h labels at the top vertex of each outline (only when downforce grows
  // the cloud — otherwise shape doesn't depend on speed and the label would be
  // misleading). Laid out top to bottom with a guaranteed gap so close
  // outlines (e.g. GT) don't overlap.
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

/** Apply a rules change: re-render and notify the caller. */
function commit(): void {
  render();
  onChange?.(rules);
}

/**
 * Open the settings sheet. current is the active rules (we copy it: changes
 * are sent out immediately via onChange, and we never mutate the caller's
 * object; drive is deep-copied since the sliders mutate it directly).
 * isOnline marks a networked race — in that case we show the time-limit row.
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
  activeTab = 'drive'; // the sheet always opens on the "Handling" tab
  render();
  openSheet(sheet);
  // The first render ran while the sheet was hidden (zero-width canvas) —
  // redraw the preview once the sheet is visible and the actual width is known.
  requestAnimationFrame(() => drawPreview());
}

/** Wire up segment and slider handlers (once, at panel init). */
export function bindSettings(): void {
  for (const el of [accelSlider, brakeSlider, gripSlider]) {
    el.min = String(DRIVE_MIN);
    el.max = String(DRIVE_MAX);
    el.step = String(DRIVE_STEP);
  }
  // Downforce has its own scale (a dimensionless 0..1.5 coefficient), unlike the mechanical axes.
  downforceSlider.min = String(DOWNFORCE_MIN);
  downforceSlider.max = String(DOWNFORCE_MAX);
  downforceSlider.step = String(DOWNFORCE_STEP);
  settingsTabs.querySelectorAll<HTMLButtonElement>('.seg__btn').forEach((btn) => {
    bindTap(btn, () => {
      activeTab = btn.dataset.tab as SettingsTab;
      applyTab();
      // Returning to "Handling": the canvas may have been sitting hidden (zero
      // width) — redraw the preview now that it's visible again (as in openSettings).
      if (activeTab === 'drive') requestAnimationFrame(() => drawPreview());
    });
  });
  // "?" hint buttons: tapping expands/collapses the explanation in that setting's row.
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
      // A preset sets the numbers; "Custom" leaves the current drive values as
      // they are (the sliders open at those values, then can be adjusted freely).
      const preset = DRIVE_PRESETS[mode as DrivePreset];
      if (preset) rules.drive = { ...preset };
      commit();
    });
  });
  const bindDrive = (el: HTMLInputElement, axis: keyof Drive): void => {
    el.addEventListener('input', () => {
      rules.drive[axis] = Number(el.value);
      mode = 'custom'; // adjusting a slider switches to manual mode
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
