// Mode select + race setup (Blueprint redesign): the floating screens shown
// between the editor and the race. Built here (their owner module) and mounted
// into .app__board on first show, rather than living statically in index.html.
//
// Mode select is a list of cards ("who's playing?"); race setup is one card with
// three tabs — Lineup (humans/bots/difficulty, clamped to the starting grid),
// Behaviour and Rules (both from the shared rules-editor component) — plus the
// pinned "Start race" action. The two local setup phases ('players' = hotseat,
// 'ai' = vs computer) share the screen and differ only in the Lineup tab.

import { Phase } from '../app-state';
import { Rules, MIN_PLAYERS } from '../model/game';
import { Difficulty } from '../model/ai';
import { strings } from '../i18n';
import { bindTap } from './dom';
import { mountRulesEditor, RulesEditor } from './rules-editor';
import {
  el,
  button,
  icon,
  buildTopbar,
  BACK_SVG,
  ARROW_SVG,
  CHEVRON_SVG,
} from './pr-chrome';

const board = document.querySelector('.app__board')!;

/** Mode-card icons from the hi-fi: a chip (bots), a phone (hotseat), a globe (online). */
const CHIP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>';
const PHONE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M11 18h2"/></svg>';
const GLOBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/></svg>';

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
/** Bot counts offered on each screen (the grid capacity disables the rest). */
const AI_BOTS = [1, 2, 3, 4, 5];
const HOTSEAT_HUMANS = [2, 3, 4, 5, 6];
const HOTSEAT_BOTS = [0, 1, 2, 3, 4, 5];

type SetupTab = 'lineup' | 'drive' | 'rules';

export interface SetupHandlers {
  /** Mode select: with friends on one device (hotseat). */
  onModeLocal: () => void;
  /** Mode select: online (opens the name dialog → creates a race). */
  onModeOnline: () => void;
  /** Mode select: against the computer. */
  onModeAI: () => void;
  /** Back from mode select (to the editor, or to the race we came from). */
  onModeBack: () => void;
  /** Back from either setup screen — to mode select. */
  onSetupBack: () => void;
  /** Start a local race with the assembled lineup. */
  onStartLocal: (humans: number, bots: number, difficulty: Difficulty) => void;
  /** The rules the Behaviour/Rules tabs edit. */
  getRules: () => Rules;
  onRulesChange: (r: Rules) => void;
}

let handlers: SetupHandlers;
let built = false;
let root: HTMLElement;
let title: HTMLElement;
let onlineCard: HTMLButtonElement;
let startBtn: HTMLButtonElement;
let rulesEditor: RulesEditor;

// ── Lineup state ─────────────────────────────────────────────────────────────
// A local race is assembled on the hotseat and "vs computer" screens. The number
// of grid seats (capacity) arrives via renderSetupChrome and constrains the
// selection; each tap re-renders. (Lived in panel.ts before the redesign.)
let setupHumans = 2;
let setupBots = 0;
let aiBots = 1;
let difficulty: Difficulty = 'medium';
let seatCapacity = 6;

let tab: SetupTab = 'lineup';
/** Phase of the previous render — to detect entering a screen. */
let lastPhase: Phase | null = null;

/** Rows of the Lineup tab (each a label + a row of options). */
interface Lineup {
  humansRow: HTMLElement;
  humansOpts: HTMLButtonElement[];
  botsRow: HTMLElement;
  botsLabel: HTMLElement;
  botsOpts: HTMLButtonElement[];
  difficultyRow: HTMLElement;
  difficultyLabel: HTMLElement;
  difficultyOpts: HTMLButtonElement[];
}
let lineup: Lineup;
const tabs: Partial<Record<SetupTab, HTMLButtonElement>> = {};
const panes: Partial<Record<SetupTab, HTMLElement>> = {};

/** One labelled row of options; returns the row and its option buttons. */
function optionRow(
  parent: HTMLElement,
  values: (string | number)[],
  onPick: (value: string) => void,
): { row: HTMLElement; label: HTMLElement; opts: HTMLButtonElement[] } {
  const row = el('div', 'pr-row', parent);
  const label = el('span', 'pr-label', row);
  const seg = el('div', 'pr-seg', row);
  const opts = values.map((v) => {
    const b = button('pr-seg__opt', seg);
    b.dataset.key = String(v);
    // Read the key at tap time, not at build time: the bots row is relabelled
    // per screen (0..5 hotseat, 1..5 vs computer), so a captured value would be
    // one option off after the swap.
    bindTap(b, () => onPick(b.dataset.key!));
    return b;
  });
  return { row, label, opts };
}

/** A mode-select card: icon, title, subtitle, chevron. */
function modeCard(
  parent: HTMLElement,
  iconSvg: string,
  label: string,
  sub: string,
  onTap: () => void,
): HTMLButtonElement {
  const card = button('pr-card pr-card--lg pr-mode', parent);
  icon('pr-mode__ico', iconSvg, card);
  const text = el('span', 'pr-mode__text', card);
  el('span', 'pr-mode__title', text).textContent = label;
  el('span', 'pr-mode__sub', text).textContent = sub;
  icon('pr-mode__chev', CHEVRON_SVG, card);
  bindTap(card, onTap);
  return card;
}

function build(): void {
  root = el('div', 'pr-layer pr-setup');
  root.hidden = true;

  const top = buildTopbar(root, {
    iconSvg: BACK_SVG,
    label: strings.buttons.back,
    onTap: () =>
      root.dataset.screen === 'mode' ? handlers.onModeBack() : handlers.onSetupBack(),
  });
  title = top.title;

  const body = el('div', 'pr-setup__body', root);

  // ── Mode select: the three cards ──────────────────────────────────────────
  const modes = el('div', 'pr-setup__modes', body);
  modeCard(modes, CHIP_SVG, strings.modeSelect.ai, strings.modeSelect.aiSub, () =>
    handlers.onModeAI(),
  );
  modeCard(modes, PHONE_SVG, strings.modeSelect.local, strings.modeSelect.localSub, () =>
    handlers.onModeLocal(),
  );
  onlineCard = modeCard(
    modes,
    GLOBE_SVG,
    strings.modeSelect.online,
    strings.modeSelect.onlineSub,
    () => handlers.onModeOnline(),
  );

  // ── Race setup: the tabbed card ───────────────────────────────────────────
  const card = el('div', 'pr-card pr-card--lg pr-setup__card', body);
  const tabRow = el('div', 'pr-setup__tabs', card);
  const addTab = (key: SetupTab, label: string): void => {
    const b = button('pr-setup__tab', tabRow);
    b.textContent = label;
    bindTap(b, () => showTab(key));
    tabs[key] = b;
  };
  addTab('lineup', strings.setup.tabLineup);
  addTab('drive', strings.setup.tabBehaviour);
  addTab('rules', strings.setup.tabRules);

  const paneBox = el('div', 'pr-setup__panes', card);
  for (const key of ['lineup', 'drive', 'rules'] as SetupTab[]) {
    panes[key] = el('div', 'pr-setup__pane', paneBox);
  }

  const lineupPane = panes.lineup!;
  const humans = optionRow(lineupPane, HOTSEAT_HUMANS, (v) => {
    setupHumans = Number(v);
    renderLineup();
  });
  const bots = optionRow(lineupPane, HOTSEAT_BOTS, (v) => {
    // The hotseat screen offers 0..5 bots; "vs computer" reuses the same row
    // with 1..5 (the option set is rebuilt per screen in renderLineup).
    setupBots = Number(v);
    aiBots = Number(v);
    renderLineup();
  });
  const diff = optionRow(lineupPane, DIFFICULTIES, (v) => {
    difficulty = v as Difficulty;
    renderLineup();
  });
  DIFFICULTIES.forEach((d, i) => {
    diff.opts[i].textContent = strings.aiSelect[d];
  });
  lineup = {
    humansRow: humans.row,
    humansOpts: humans.opts,
    botsRow: bots.row,
    botsLabel: bots.label,
    botsOpts: bots.opts,
    difficultyRow: diff.row,
    difficultyLabel: diff.label,
    difficultyOpts: diff.opts,
  };
  humans.label.textContent = strings.players.humansLabel;

  rulesEditor = mountRulesEditor({ drive: panes.drive!, rules: panes.rules! });

  // ── Actions (aligned to the same gutter as everything else). On wide screens
  //    the top bar gives way to the rail, so Back joins this row. ────────────
  const actions = el('div', 'pr-setup__actions', body);
  const backBtn = button('pr-btn pr-setup__back', actions);
  backBtn.textContent = strings.buttons.back;
  bindTap(backBtn, () =>
    root.dataset.screen === 'mode' ? handlers.onModeBack() : handlers.onSetupBack(),
  );
  startBtn = button('pr-btn pr-btn--primary pr-btn--caps pr-setup__start', actions);
  startBtn.textContent = strings.setup.start;
  icon('pr-btn__arrow', ARROW_SVG, startBtn);
  bindTap(startBtn, () =>
    handlers.onStartLocal(
      isAi() ? 1 : setupHumans,
      isAi() ? aiBots : setupBots,
      difficulty,
    ),
  );

  board.append(root);
  built = true;
}

/** Whether the setup screen is currently showing the "vs computer" lineup. */
const isAi = (): boolean => root.dataset.mode === 'ai';

function showTab(next: SetupTab): void {
  tab = next;
  for (const key of ['lineup', 'drive', 'rules'] as SetupTab[]) {
    tabs[key]!.classList.toggle('pr-setup__tab--active', key === tab);
    panes[key]!.hidden = key !== tab;
  }
  // The preview canvas has no width while its pane is hidden, so a render done
  // then drew nothing — redraw once it's visible again.
  if (tab === 'drive') requestAnimationFrame(() => rulesEditor.refreshPreview());
}

/**
 * Lineup tab. Vs computer: one human (fixed) plus 1..(capacity − 1) bots, with
 * difficulty always relevant. Hotseat: 2..capacity humans, bots filling the
 * remaining seats, difficulty only once a bot is racing. Options beyond the
 * starting grid's capacity are disabled rather than hidden — the limit reads as
 * a rule of the track, not an error.
 */
function renderLineup(): void {
  const ai = isAi();
  lineup.humansRow.hidden = ai;
  if (ai) {
    aiBots = Math.max(1, Math.min(aiBots, Math.max(1, seatCapacity - 1)));
    lineup.botsLabel.textContent = strings.aiSelect.botsLabel;
    lineup.botsOpts.forEach((b, i) => {
      const n = AI_BOTS[i];
      b.hidden = n === undefined;
      if (n === undefined) return;
      b.dataset.key = String(n);
      b.textContent = String(n);
      b.disabled = 1 + n > seatCapacity;
      b.classList.toggle('pr-seg__opt--active', n === aiBots);
    });
    lineup.difficultyRow.hidden = false;
    lineup.difficultyLabel.textContent = strings.aiSelect.difficultyLabel;
    startBtn.disabled = seatCapacity < MIN_PLAYERS;
  } else {
    // Clamp to capacity: humans from MIN_PLAYERS up to the grid size, bots fill
    // the remainder. Humans have a floor of MIN_PLAYERS — a race with a single
    // human is the "vs computer" mode, not hotseat.
    setupHumans = Math.max(MIN_PLAYERS, Math.min(setupHumans, seatCapacity));
    setupBots = Math.max(0, Math.min(setupBots, seatCapacity - setupHumans));
    lineup.humansOpts.forEach((b, i) => {
      const n = HOTSEAT_HUMANS[i];
      b.textContent = String(n);
      b.disabled = n > seatCapacity;
      b.classList.toggle('pr-seg__opt--active', n === setupHumans);
    });
    const seatsLeft = Math.max(0, seatCapacity - setupHumans);
    lineup.botsLabel.textContent = strings.players.botsWithSeats(seatsLeft);
    lineup.botsOpts.forEach((b, i) => {
      const n = HOTSEAT_BOTS[i];
      b.hidden = false;
      b.dataset.key = String(n);
      b.textContent = String(n);
      b.disabled = setupHumans + n > seatCapacity;
      b.classList.toggle('pr-seg__opt--active', n === setupBots);
    });
    lineup.difficultyRow.hidden = setupBots === 0;
    lineup.difficultyLabel.textContent = strings.players.difficultyLabel;
    const total = setupHumans + setupBots;
    startBtn.disabled = total < MIN_PLAYERS || total > seatCapacity;
  }
  for (const b of lineup.difficultyOpts) {
    b.classList.toggle('pr-seg__opt--active', b.dataset.key === difficulty);
  }
}

export function initSetupChrome(h: SetupHandlers): void {
  handlers = h;
  build();
}

/** Hide the online mode card when the backend isn't configured (local play only). */
export function setSetupOnlineEnabled(enabled: boolean): void {
  if (built) onlineCard.hidden = !enabled;
}

/**
 * Render the setup chrome for the current phase: mode select, one of the two
 * local setup screens, or nothing (the panel takes over again in every other
 * phase, via body.is-setup).
 */
export function renderSetupChrome(phase: Phase, playersMax: number): void {
  if (!built) return;
  const inSetup = phase === 'modeSelect' || phase === 'players' || phase === 'ai';
  root.hidden = !inSetup;
  document.body.classList.toggle('is-setup', inSetup);
  seatCapacity = playersMax;
  if (!inSetup) {
    lastPhase = phase;
    return;
  }

  const mode = phase === 'modeSelect' ? 'mode' : 'setup';
  root.dataset.screen = mode;
  root.dataset.mode = phase === 'ai' ? 'ai' : 'hotseat';
  title.textContent =
    phase === 'modeSelect' ? strings.modeSelect.title : strings.setup.title;

  if (phase !== 'modeSelect') {
    // Entering the setup screen: always open on Lineup, and hand the editor a
    // fresh copy of the current rules (local race — no turn limit).
    if (lastPhase !== phase) {
      rulesEditor.open(handlers.getRules(), false, handlers.onRulesChange);
      showTab('lineup');
    }
    renderLineup();
  }
  lastPhase = phase;
}
