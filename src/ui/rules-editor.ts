// Race-rules editor (Blueprint redesign): car handling (Sports/GT/F1/Classic
// presets, or a manual "Custom" mode with accel/brake/grip/downforce sliders and
// a live preview of the reachable-moves cloud) and race rules (race length in
// laps, crash-penalty type, dynamic-formula strictness, static-penalty size,
// per-turn time limit — online only).
//
// A mountable component rather than a screen: it builds its controls into the
// hosts it's given, so the same implementation serves the race-setup screen's
// "Behaviour"/"Rules" tabs and the settings sheet the lobby still opens. The
// caller holds the actual rules — they arrive here as a copy, and changes are
// sent back out via onChange.

import { Rules, Drive } from '../model/game';
import { reachableTargets, aeroFactor, forwardCap } from '../model/turns';
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
  STATIC_TURNS_MIN,
  STATIC_TURNS_MAX,
  LAP_OPTIONS,
  DEFAULT_WIN_CROSSINGS,
} from '../config';
import { strings } from '../i18n';
import { bindTap } from './dom';
import { el, button } from './pr-chrome';
import { DriveMode, driveModeOf } from './rules-summary';

type DrivePreset = keyof typeof DRIVE_PRESETS;

/** The exponent corresponding to the selected strictness segment. */
const exponentOf = (kind: string): number =>
  kind === 'strict' ? CRASH_EXPONENT_STRICT : CRASH_EXPONENT_STANDARD;

// ── Small builders for the shared Blueprint controls ─────────────────────────

interface Seg {
  root: HTMLElement;
  opts: HTMLButtonElement[];
}

/** A segmented control: one option per item, at most one active. */
function seg(
  parent: HTMLElement,
  mod: string,
  items: { key: string; label: string }[],
  onPick: (key: string) => void,
): Seg {
  const root = el('div', `pr-seg${mod}`, parent);
  const opts = items.map((it) => {
    const b = button('pr-seg__opt', root);
    b.dataset.key = it.key;
    b.textContent = it.label;
    bindTap(b, () => onPick(it.key));
    return b;
  });
  return { root, opts };
}

function markSeg(s: Seg, active: string): void {
  for (const b of s.opts) {
    b.classList.toggle('pr-seg__opt--active', b.dataset.key === active);
  }
}

interface Row {
  root: HTMLElement;
  /** Where the control goes (between the label row and the explanation). */
  body: HTMLElement;
  /** Current-value readout in the head (slider rows). */
  value: HTMLElement;
}

/** A setting: label (+ a "?" that expands the explanation) over its control. */
function settingRow(parent: HTMLElement, label: string, hintText?: string): Row {
  const root = el('div', 'pr-row', parent);
  const head = el('div', 'pr-row__head', root);
  el('span', 'pr-label', head).textContent = label;
  const value = el('span', 'pr-row__value', head);
  const body = el('div', 'pr-row__body', root);
  if (hintText) {
    const help = button('pr-help', head);
    help.textContent = '?';
    help.setAttribute('aria-label', strings.settings.helpLabel);
    help.setAttribute('aria-expanded', 'false');
    const hint = el('p', 'pr-hint', root);
    hint.textContent = hintText;
    hint.hidden = true;
    // The value readout is pushed right by margin-left:auto, so the "?" must
    // sit before it in the DOM to stay next to the label.
    head.insertBefore(help, value);
    bindTap(help, () => {
      hint.hidden = !hint.hidden;
      help.setAttribute('aria-expanded', String(!hint.hidden));
    });
  }
  return { root, body, value };
}

export interface RulesEditorHosts {
  /** Container for the car-handling controls ("Behaviour"). */
  drive: HTMLElement;
  /** Container for the race-rules controls ("Rules"). */
  rules: HTMLElement;
}

export interface RulesEditor {
  /**
   * Point the editor at the given rules and render. The rules are copied (the
   * controls mutate the copy; the caller is notified via onChange and never has
   * its own object mutated). isOnline shows the online-only time-limit row.
   */
  open(
    current: Rules,
    isOnline: boolean,
    onChange: (r: Rules) => void,
    readOnly?: boolean,
  ): void;
  /** Redraw the preview — call after the canvas becomes visible (it has no
   *  width while hidden, so a render done then produced nothing). */
  refreshPreview(): void;
}

/** Build the handling + rules controls into the given hosts and wire them up. */
export function mountRulesEditor(hosts: RulesEditorHosts): RulesEditor {
  // Working copy of the rules and the outward callback — set by open(). mode is
  // which handling segment is shown (kept locally, not stored in Rules: Rules
  // only carries the numeric drive values).
  let rules: Rules = { ...DEFAULT_PREVIEW_RULES };
  let mode: DriveMode = 'sports';
  let online = false;
  let readOnly = false;
  let onChange: ((r: Rules) => void) | null = null;

  const commit = (): void => {
    render();
    onChange?.(rules);
  };

  // ── Handling ───────────────────────────────────────────────────────────────
  const driveRoot = el('div', 'pr-rules pr-rules--drive', hosts.drive);
  const driveNote = el('p', 'pr-note pr-rules__ro-note', driveRoot);
  driveNote.textContent = strings.settings.readOnlyNote;
  const pickMode = (key: string): void => {
    mode = key as DriveMode;
    // A preset sets the numbers; "Custom" leaves the current drive values as
    // they are (the sliders open at those values, then can be adjusted freely).
    const preset = DRIVE_PRESETS[mode as DrivePreset];
    if (preset) rules.drive = { ...preset };
    commit();
  };
  const presetsTop = seg(
    driveRoot,
    ' pr-seg--grid3',
    [
      { key: 'sports', label: strings.settings.driveModeSports },
      { key: 'gt', label: strings.settings.driveModeGt },
      { key: 'f1', label: strings.settings.driveModeF1 },
    ],
    pickMode,
  );
  const presetsBottom = seg(
    driveRoot,
    ' pr-seg--grid2',
    [
      { key: 'classic', label: strings.settings.driveModeClassic },
      { key: 'custom', label: strings.settings.driveModeCustom },
    ],
    pickMode,
  );
  const explain = el('p', 'pr-note', driveRoot);

  const sliderBox = el('div', 'pr-rules__sliders', driveRoot);
  const driveAxis = (
    label: string,
    axis: keyof Drive,
  ): { input: HTMLInputElement; value: HTMLElement } => {
    const row = settingRow(sliderBox, label);
    const input = el('input', 'pr-slider', row.body);
    input.type = 'range';
    input.addEventListener('input', () => {
      rules.drive[axis] = Number(input.value);
      mode = 'custom'; // adjusting a slider switches to manual mode
      commit();
    });
    return { input, value: row.value };
  };
  const axes = {
    accel: driveAxis(strings.settings.driveAccel, 'accel'),
    brake: driveAxis(strings.settings.driveBrake, 'brake'),
    grip: driveAxis(strings.settings.driveGrip, 'grip'),
    downforce: driveAxis(strings.settings.driveDownforce, 'downforce'),
  };
  for (const a of [axes.accel, axes.brake, axes.grip]) {
    a.input.min = String(DRIVE_MIN);
    a.input.max = String(DRIVE_MAX);
    a.input.step = String(DRIVE_STEP);
  }
  // Downforce has its own scale (a dimensionless coefficient), unlike the mechanical axes.
  axes.downforce.input.min = String(DOWNFORCE_MIN);
  axes.downforce.input.max = String(DOWNFORCE_MAX);
  axes.downforce.input.step = String(DOWNFORCE_STEP);

  const previewBox = el('div', 'pr-rules__preview', driveRoot);
  el('span', 'pr-label', previewBox).textContent = strings.settings.reachableCells;
  const previewCard = el('div', 'pr-preview', previewBox);
  const preview = el('canvas', 'pr-preview__canvas', previewCard);
  // The cloud is laid out in the canvas's own pixels, so a size change (tab
  // shown, rail resized, orientation flip) needs a redraw — otherwise the last
  // raster is stretched to the new box.
  new ResizeObserver(() => drawPreview(preview, rules.drive)).observe(previewCard);

  // ── Rules ──────────────────────────────────────────────────────────────────
  const rulesRoot = el('div', 'pr-rules pr-rules--rules', hosts.rules);
  const rulesNote = el('p', 'pr-note pr-rules__ro-note', rulesRoot);
  rulesNote.textContent = strings.settings.readOnlyNote;

  // Laps come first: it's the setting that decides how long the race is, and on
  // a single lap the finishing order mostly repeats the starting grid.
  const lapsRow = settingRow(
    rulesRoot,
    strings.settings.lapsLabel,
    strings.settings.lapsHint,
  );
  const laps = seg(
    lapsRow.body,
    '',
    LAP_OPTIONS.map((n) => ({ key: String(n), label: strings.settings.lapsOption(n) })),
    (key) => {
      // The start crossing is counted right away, so N laps = N + 1 crossings.
      rules.winCrossings = Number(key) + 1;
      commit();
    },
  );

  const penaltyRow = settingRow(
    rulesRoot,
    strings.settings.penaltyLabel,
    strings.settings.penaltyHint,
  );
  const penalty = seg(
    penaltyRow.body,
    '',
    [
      { key: 'dynamic', label: strings.settings.dynamic },
      { key: 'static', label: strings.settings.static },
    ],
    (key) => {
      rules.penalty = key as Rules['penalty'];
      commit();
    },
  );

  const exponentRow = settingRow(
    rulesRoot,
    strings.settings.exponentLabel,
    strings.settings.exponentHint,
  );
  const exponent = seg(
    exponentRow.body,
    '',
    [
      { key: 'standard', label: strings.settings.exponentStandard },
      { key: 'strict', label: strings.settings.exponentStrict },
    ],
    (key) => {
      rules.dynamicExponent = exponentOf(key);
      commit();
    },
  );

  const staticRow = settingRow(
    rulesRoot,
    strings.settings.staticTurnsLabel,
    strings.settings.staticTurnsHint,
  );
  const staticSlider = el('input', 'pr-slider', staticRow.body);
  staticSlider.type = 'range';
  staticSlider.min = String(STATIC_TURNS_MIN);
  staticSlider.max = String(STATIC_TURNS_MAX);
  staticSlider.step = '1';
  const staticScale = el('div', 'pr-slider__scale', staticRow.body);
  el('span', '', staticScale).textContent = String(STATIC_TURNS_MIN);
  el('span', '', staticScale).textContent = String(STATIC_TURNS_MAX);
  staticSlider.addEventListener('input', () => {
    rules.staticTurns = Number(staticSlider.value);
    commit();
  });

  const turnLimitRow = settingRow(
    rulesRoot,
    strings.settings.turnLimitLabel,
    strings.settings.turnLimitHint,
  );
  const turnLimit = seg(
    turnLimitRow.body,
    '',
    [
      { key: '30000', label: strings.settings.limit30s },
      { key: '60000', label: strings.settings.limit1m },
      { key: '120000', label: strings.settings.limit2m },
      { key: '300000', label: strings.settings.limit5m },
    ],
    (key) => {
      rules.turnLimitMs = Number(key);
      commit();
    },
  );

  /**
   * Read-only (a guest looking at the host's settings): the controls become a
   * readout. Not merely disabled — a greyed-out button still reads as something
   * to press. The unselected options lose their button skin (see .pr-rules--ro in
   * pr-controls.css), the sliders go away entirely (their value is printed beside
   * the label anyway), and a line at the top says whose settings these are. The
   * "?" explanations stay live: a guest needs them most.
   */
  function applyReadOnly(): void {
    for (const root of [driveRoot, rulesRoot]) {
      root.classList.toggle('pr-rules--ro', readOnly);
    }
    driveNote.hidden = !readOnly;
    rulesNote.hidden = !readOnly;
    const segs = [presetsTop, presetsBottom, laps, penalty, exponent, turnLimit];
    for (const s of segs) {
      for (const b of s.opts) b.disabled = readOnly;
    }
    for (const a of Object.values(axes)) a.input.disabled = readOnly;
    staticSlider.disabled = readOnly;
  }

  /** Refresh every control to match the current rules. */
  function render(): void {
    markSeg(presetsTop, mode);
    markSeg(presetsBottom, mode);
    // Presets get an explanation; "Custom" gets sliders. The preview is always visible.
    const custom = mode === 'custom';
    sliderBox.hidden = !custom;
    explain.hidden = custom;
    if (!custom) {
      const text: Record<DrivePreset, string> = {
        sports: strings.settings.driveExplainSports,
        gt: strings.settings.driveExplainGt,
        f1: strings.settings.driveExplainF1,
        classic: strings.settings.driveExplainClassic,
      };
      explain.textContent = text[mode as DrivePreset];
    }
    for (const [axis, ctl] of Object.entries(axes)) {
      const v = rules.drive[axis as keyof Drive];
      ctl.input.value = String(v);
      ctl.value.textContent = String(v);
    }
    drawPreview(preview, rules.drive);

    markSeg(laps, String(rules.winCrossings - 1));
    markSeg(penalty, rules.penalty);
    markSeg(
      exponent,
      rules.dynamicExponent === CRASH_EXPONENT_STRICT ? 'strict' : 'standard',
    );
    markSeg(turnLimit, String(rules.turnLimitMs));
    turnLimitRow.root.hidden = !online;
    const dynamic = rules.penalty === 'dynamic';
    exponentRow.root.hidden = !dynamic;
    staticRow.root.hidden = dynamic;
    staticSlider.value = String(rules.staticTurns);
    staticRow.value.textContent = String(rules.staticTurns);
  }

  return {
    open(current, isOnline, onChangeCb, ro = false) {
      rules = { ...current, drive: { ...current.drive } };
      mode = driveModeOf(rules.drive);
      online = isOnline;
      readOnly = ro;
      onChange = onChangeCb;
      applyReadOnly();
      render();
    },
    refreshPreview() {
      drawPreview(preview, rules.drive);
    },
  };
}

/** Placeholder until open() supplies the real rules (the controls are built
 *  before any screen shows them). */
const DEFAULT_PREVIEW_RULES = {
  winCrossings: DEFAULT_WIN_CROSSINGS,
  penalty: 'dynamic',
  dynamicExponent: CRASH_EXPONENT_STANDARD,
  staticTurns: STATIC_TURNS_MIN,
  turnLimitMs: 60000,
  drive: { ...DRIVE_PRESETS.sports },
} as Rules;

/** Speeds (cells/turn) for the preview cloud: 0.5 / 1 / 1.5 × DOWNFORCE_VREF
 *  (low ≈ pure mechanics, mid = the downforce reference speed, high = downforce
 *  at full strength). In km/h (× KMH_PER_CELL): 150 / 300 / 450. */
const PREVIEW_SPEEDS = [3, 6, 9] as const;

/**
 * Live preview of the reachable-moves cloud for the given drive settings. We
 * draw the cloud at several speeds (PREVIEW_SPEEDS), all aligned to a shared
 * coasting point: as speed increases, aerodynamic downforce widens both
 * lateral grip and braking (aero grows with the square of speed), so the
 * cloud swells — something a single-speed view wouldn't show. Points are
 * tinted by tier (saturated ones are reachable already at low speed, faded
 * ones are added by downforce), and the outlines carry km/h labels.
 * downforce = 0 → shape doesn't depend on speed, so we show a single cloud.
 * Targets come from reachableTargets — no duplicating the model.
 */
function drawPreview(canvas: HTMLCanvasElement, drive: Drive): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 240;
  const cssH = canvas.clientHeight || 190;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { accel, brake, grip, downforce } = drive;
  // downforce = 0 → aero ≡ 1 at any speed, so the cloud doesn't grow: a single speed (no labels).
  const showSpeeds = downforce > 0;
  const speeds = showSpeeds ? [...PREVIEW_SPEEDS] : [PREVIEW_SPEEDS[0]];

  // One layer per speed: offsets a = target − C (cells relative to the SHARED
  // coasting point) plus the effective ellipse semi-axes (front = forwardCap,
  // which downforce leaves untouched).
  const layers = speeds.map((v) => {
    const aero = aeroFactor(downforce, v);
    const off = reachableTargets({ x: 0, y: 0 }, { x: v, y: 0 }, drive).map((c) => ({
      x: c.x - v,
      y: c.y,
    }));
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
  let maxX = forwardCap(accel);
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
  ctx.fillStyle = PREVIEW_GRID;
  for (let gy = Math.ceil(minY); gy <= Math.floor(maxY); gy++) {
    for (let gx = Math.ceil(minX); gx <= Math.floor(maxX); gx++) {
      ctx.beginPath();
      ctx.arc(X(gx), Y(gy), 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Direction arrow: pointing left into the coasting point — the ellipse is
  // asymmetric (front is acceleration, back is braking).
  ctx.strokeStyle = PREVIEW_ARROW;
  ctx.fillStyle = PREVIEW_ARROW;
  ctx.lineWidth = 1.6;
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
  // Half-ellipse: front = forwardCap(accel), back = back, side = side.
  const traceEllipse = (back: number, side: number): void => {
    ctx.beginPath();
    ctx.ellipse(
      cx,
      cy,
      forwardCap(accel) * cell,
      side * cell,
      0,
      -Math.PI / 2,
      Math.PI / 2,
    );
    ctx.ellipse(cx, cy, back * cell, side * cell, 0, Math.PI / 2, (3 * Math.PI) / 2);
    ctx.closePath();
  };
  const strokeA = [0.7, 0.55, 0.42];
  const strokeW = [1.8, 1.6, 1.4];
  for (let i = layers.length - 1; i >= 0; i--) {
    traceEllipse(layers[i].back, layers[i].side);
    ctx.fillStyle = PREVIEW_FILL;
    ctx.fill();
    ctx.strokeStyle = withAlpha(PREVIEW_ACCENT, strokeA[i]);
    ctx.lineWidth = strokeW[i];
    ctx.stroke();
  }

  // Candidate points, tinted by tier (saturated ones are reachable already at
  // low speed, faded ones were added by downforce at speed).
  const dotAlpha = [0.85, 0.5, 0.3];
  const dotR = Math.max(2.2, cell * 0.14);
  ctx.fillStyle = PREVIEW_ACCENT;
  for (const p of points) {
    if (p.x === 0 && p.y === 0) continue; // the coasting point is drawn as a ring
    ctx.globalAlpha = dotAlpha[p.tier] ?? 0.3;
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y), dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The coasting point — a ring.
  ctx.strokeStyle = PREVIEW_INK;
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
    ctx.font = '700 10px ui-monospace, "SF Mono", Menlo, monospace';
    ctx.lineJoin = 'round';
    let prevLy = -Infinity;
    for (const l of [...layers].sort((a, b) => b.side - a.side)) {
      const ly = Math.max(Y(-l.side) - 3, prevLy + 12);
      prevLy = ly;
      const label = `${l.v * KMH_PER_CELL} ${strings.race.speedUnit}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = PREVIEW_BG;
      ctx.strokeText(label, cx, ly);
      ctx.fillStyle = PREVIEW_ACCENT;
      ctx.fillText(label, cx, ly);
    }
  }
}

// Preview palette — the Blueprint tokens, mirrored here because canvas can't
// read CSS custom properties (same tradeoff as view/render.ts).
const PREVIEW_ACCENT = '#ffb454'; // --pr-accent
const PREVIEW_INK = '#eaf6ff'; // --pr-ink
const PREVIEW_BG = '#0d3252'; // --pr-board (label halo)
const PREVIEW_GRID = '#3a5978'; // node grid on the dark card
const PREVIEW_ARROW = '#7a8ba3'; // quiet direction arrow
const PREVIEW_FILL = 'rgba(255, 180, 84, 0.05)';

const withAlpha = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
