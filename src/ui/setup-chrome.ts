// Mode select + race setup (Blueprint redesign): steps 5 and 6 of the run-up to
// a race, shown between the editor and the grid. Built here (their owner module)
// and mounted into .app__board on first show, rather than living statically in
// index.html. The step title, counter and progress come from the shared step
// navigation (wizard-nav.ts), the same one the drawing steps use — this module
// only owns the two screens' content and their actions.
//
// Mode select is a list of cards ("who's playing?"); race setup is one card with
// three tabs — Lineup (humans/bots/difficulty, clamped to the starting grid),
// Behaviour and Rules (both from the shared rules-editor component) — plus the
// pinned "Start race" action. The two local setup phases ('players' = hotseat,
// 'ai' = vs computer) share the screen and differ only in the Lineup tab.
//
// The host's online lobby is a THIRD variant of the same screen, not a screen of
// its own: waiting for friends is still setting a race up, so the room code and
// the roster take the place of the seat counters in the Lineup tab and everything
// else — tabs, rules, the Start action, the step it occupies in the wizard —
// stays where it was. (The guest's lobby is its own screen, ui/online-lobby.ts:
// a guest has nothing to set.)

import { Phase } from '../app-state';
import { Rules, MIN_PLAYERS } from '../model/game';
import { Difficulty } from '../model/ai';
import { strings } from '../i18n';
import { bindTap } from './dom';
import { openConfirm } from './confirm';
import { mountRulesEditor, RulesEditor } from './rules-editor';
import {
  el,
  button,
  icon,
  buildItem,
  buildCode,
  buildRoster,
  buildTabs,
  CodeBlock,
  LobbyView,
  Roster,
  Tabs,
} from './pr-chrome';
import { ARROW_SVG, CHIP_SVG, CLOSE_SVG, GLOBE_SVG, PHONE_SVG } from './icons';

const board = document.querySelector('.app__board')!;

const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
/** Bot counts offered on each screen (the grid capacity disables the rest).
 *  A full grid of bots is only ever reachable in "vs computer" — hotseat and
 *  the online lobby always seat at least two people, so the sixth option would
 *  be permanently out of reach and is simply not offered there. Both rows are
 *  the same length: one set of buttons serves them by index. */
const AI_BOTS = [1, 2, 3, 4, 5];
const HOTSEAT_HUMANS = [2, 3, 4, 5, 6];
const HOTSEAT_BOTS = [0, 1, 2, 3, 4];

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
  /** Online lobby (host): the room's own actions. */
  onLobbyStart: () => void;
  onLobbyCopyCode: () => void;
  onLobbyShare: () => void;
  onLobbyLeave: () => void;
  /** Host-local bots filling the free seats. */
  onLobbyBotCount: (n: number) => void;
  onLobbyBotDifficulty: (d: Difficulty) => void;
  /** Our own name, as typed into the roster row. */
  onRename: (name: string) => void;
}

let handlers: SetupHandlers;
let built = false;
let root: HTMLElement;
let modeScreen: HTMLElement;
let setupScreen: HTMLElement;
let onlineCard: HTMLButtonElement;
let backBtn: HTMLButtonElement;
let startBtn: HTMLButtonElement;
let hintEl: HTMLElement;
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
/** The room, when this screen is standing in for the host's lobby; null locally. */
let lobbyView: LobbyView | null = null;

/** Rows of the Lineup tab (each a label + a row of options). */
interface Lineup {
  /** Online only: the room code and who's in the room. */
  codeRow: HTMLElement;
  code: CodeBlock;
  rosterRow: HTMLElement;
  rosterLabel: HTMLElement;
  roster: Roster;
  leaveBtn: HTMLButtonElement;
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
let tabbar: Tabs<SetupTab>;

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
  const card = buildItem(parent, {
    cls: 'pr-item--lg pr-card pr-card--lg',
    iconSvg,
    title: label,
    sub,
    chevron: true,
  });
  bindTap(card, onTap);
  return card;
}

function build(): void {
  root = el('div', 'pr-layer pr-setup');
  root.hidden = true;

  const body = el('div', 'pr-setup__body', root);

  // ── Mode select: the three cards ──────────────────────────────────────────
  // Each screen is its own element in the column (rather than parts of one
  // screen shown and hidden): they are the two steps a slide transition will
  // move independently.
  modeScreen = el('div', 'pr-setup__screen pr-setup__screen--mode', body);
  const modes = el('div', 'pr-setup__modes', modeScreen);
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
  setupScreen = el('div', 'pr-setup__screen pr-setup__screen--setup', body);
  const card = el('div', 'pr-card pr-card--lg pr-setup__card', setupScreen);
  // Why the primary action is held back, when it is (an empty name, too few
  // racers). Belongs to this screen rather than to the column: the action row
  // below is shared with mode select, but Start — and so its excuse — is not.
  // Last child, so it still sits right above the button it explains.
  hintEl = el('div', 'pr-setup__hint', setupScreen);
  hintEl.hidden = true;
  tabbar = buildTabs<SetupTab>(
    card,
    [
      { key: 'lineup', label: strings.setup.tabLineup },
      { key: 'drive', label: strings.setup.tabBehaviour },
      { key: 'rules', label: strings.setup.tabRules },
    ],
    showTab,
  );

  const lineupPane = tabbar.panes.lineup;
  // Online lobby blocks first (hidden for a local race): the room is the thing
  // you're waiting on, the bots below it are the filler.
  const codeRow = el('div', 'pr-row', lineupPane);
  el('span', 'pr-label', codeRow).textContent = strings.online.roomCode;
  const code = buildCode(codeRow, {
    onCopy: () => handlers.onLobbyCopyCode(),
    onShare: () => handlers.onLobbyShare(),
  });
  const rosterRow = el('div', 'pr-row', lineupPane);
  const rosterLabel = el('span', 'pr-label', rosterRow);
  const roster = buildRoster(
    rosterRow,
    {
      placeholder: strings.online.namePlaceholder,
      hostBadge: strings.online.hostBadge,
      youBadge: strings.online.you,
      offline: strings.online.offline,
    },
    (name) => handlers.onRename(name),
  );

  const humans = optionRow(lineupPane, HOTSEAT_HUMANS, (v) => {
    setupHumans = Number(v);
    renderLineup();
  });
  const bots = optionRow(lineupPane, HOTSEAT_BOTS, (v) => {
    // The hotseat screen offers 0..4 bots; "vs computer" reuses the same row
    // with 1..5, and the lobby with however many seats are free (the option set
    // is rebuilt per screen in renderLineup).
    if (lobbyView) {
      handlers.onLobbyBotCount(Number(v));
      return; // the session owns the count — it re-renders us
    }
    setupBots = Number(v);
    aiBots = Number(v);
    renderLineup();
  });
  const diff = optionRow(lineupPane, DIFFICULTIES, (v) => {
    difficulty = v as Difficulty;
    if (lobbyView) {
      handlers.onLobbyBotDifficulty(difficulty);
      return;
    }
    renderLineup();
  });
  DIFFICULTIES.forEach((d, i) => {
    diff.opts[i].textContent = strings.aiSelect[d];
  });
  // Leaving is the lobby's way out — the action row's Back would be ambiguous
  // (going back means giving up the room), so it sits at the end of the list.
  // This screen is the *host's* lobby (renderSetupChrome only keeps `lobbyView`
  // for a host, and the button is hidden without it), and for them walking out
  // closes the room rather than freeing a seat — hence "Cancel game", not the
  // guest's "Leave game" over in online-lobby.ts.
  const leaveBtn = button('pr-btn pr-btn--caps pr-setup__leave', lineupPane);
  icon('pr-btn__ico', CLOSE_SVG, leaveBtn);
  el('span', 'pr-setup__leave-label', leaveBtn).textContent = strings.online.cancelRace;
  // Ask first — this one closes the room out from under everyone who joined.
  // The confirmation is wired here rather than onto `onLobbyLeave` because the
  // two lobby screens share that handler: the guest's way out (online-lobby.ts)
  // and the guest's "leave" on the results screen are cheap and reversible —
  // they free one seat and can be undone by rejoining with the code — so they
  // stay one tap. Only the host's is destructive, and only this button is the
  // host's.
  bindTap(leaveBtn, () =>
    openConfirm(strings.online.cancelConfirm, strings.online.cancelRace, () =>
      handlers.onLobbyLeave(),
    ),
  );

  lineup = {
    codeRow,
    code,
    rosterRow,
    rosterLabel,
    roster,
    leaveBtn,
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

  rulesEditor = mountRulesEditor({
    drive: tabbar.panes.drive,
    rules: tabbar.panes.rules,
  });

  // ── Actions (aligned to the same gutter as everything else). Back lives here
  //    on every width: the top strip is the wizard's now, and its leading button
  //    is the burger. ─────────────────────────────────────────────────────────
  const actions = el('div', 'pr-setup__actions', body);
  backBtn = button('pr-btn pr-setup__back', actions);
  backBtn.textContent = strings.buttons.back;
  bindTap(backBtn, () =>
    root.dataset.screen === 'mode' ? handlers.onModeBack() : handlers.onSetupBack(),
  );
  startBtn = button('pr-btn pr-btn--primary pr-btn--caps pr-setup__start', actions);
  startBtn.textContent = strings.setup.start;
  icon('pr-btn__arrow', ARROW_SVG, startBtn);
  bindTap(startBtn, () => {
    if (lobbyView) {
      handlers.onLobbyStart();
      return;
    }
    handlers.onStartLocal(
      isAi() ? 1 : setupHumans,
      isAi() ? aiBots : setupBots,
      difficulty,
    );
  });

  board.append(root);
  built = true;
}

/** Whether the setup screen is currently showing the "vs computer" lineup. */
const isAi = (): boolean => root.dataset.mode === 'ai';

/** Label the primary action, keeping its trailing arrow. */
function setStartLabel(text: string): void {
  if (startBtn.firstChild?.textContent === text) return;
  startBtn.textContent = text;
  icon('pr-btn__arrow', ARROW_SVG, startBtn);
}

function showTab(next: SetupTab): void {
  tab = next;
  tabbar.show(tab);
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
/**
 * Lineup tab, online lobby variant: the room code, who's in the room, and the
 * bots the host tops the grid up with. The seat counters have nothing to say
 * here — who's racing is whoever joins.
 */
function renderLobbyLineup(v: LobbyView): void {
  lineup.code.set(v.code);
  lineup.rosterLabel.textContent = strings.online.players(v.players.length, v.seats);
  // Alone in the room: say so, rather than showing a roster of one and no reason.
  lineup.roster.render(v.players, v.players.length < 2 ? strings.online.noGuests : null);

  lineup.botsLabel.textContent = strings.players.botsWithSeats(v.maxBots);
  lineup.botsOpts.forEach((b, i) => {
    const n = HOTSEAT_BOTS[i];
    b.dataset.key = String(n);
    b.textContent = String(n);
    b.disabled = n > v.maxBots;
    b.classList.toggle('pr-seg__opt--active', n === v.botCount);
  });
  lineup.difficultyRow.hidden = v.botCount === 0;
  lineup.difficultyLabel.textContent = strings.players.difficultyLabel;
  for (const b of lineup.difficultyOpts) {
    b.classList.toggle('pr-seg__opt--active', b.dataset.key === v.botDifficulty);
  }

  startBtn.disabled = v.starting || !v.canStart || v.needsName || !v.connected;
  setStartLabel(v.starting ? strings.online.starting : strings.setup.start);
  // One reason at a time, most pressing first: with the channel down nothing
  // else on this screen is trustworthy, so that outranks the rest. (This line is
  // the host's connection indicator — the global banner steps aside in the
  // lobby, and the guest's own status banner says the same thing.)
  const hint = !v.connected
    ? strings.online.reconnecting
    : v.needsName
      ? strings.online.enterName
      : v.canStart
        ? ''
        : strings.online.waiting;
  hintEl.textContent = hint;
  hintEl.hidden = !hint;
  hintEl.classList.toggle('pr-setup__hint--error', !v.connected);
}

function renderLineup(): void {
  const online = lobbyView;
  // Which blocks this variant of the tab is made of.
  lineup.codeRow.hidden = !online;
  lineup.rosterRow.hidden = !online;
  lineup.leaveBtn.hidden = !online;
  backBtn.hidden = !!online;
  if (online) {
    lineup.humansRow.hidden = true;
    lineup.botsRow.hidden = false;
    renderLobbyLineup(online);
    return;
  }
  hintEl.hidden = true;
  setStartLabel(strings.setup.start);

  const ai = isAi();
  lineup.humansRow.hidden = ai;
  if (ai) {
    aiBots = Math.max(1, Math.min(aiBots, Math.max(1, seatCapacity - 1)));
    lineup.botsLabel.textContent = strings.aiSelect.botsLabel;
    lineup.botsOpts.forEach((b, i) => {
      const n = AI_BOTS[i];
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
 * local setup screens, the host's online lobby (`lobby` non-null — same screen,
 * room instead of seat counters), or nothing (the panel takes over again in
 * every other phase, via body.is-setup).
 */
export function renderSetupChrome(
  phase: Phase,
  playersMax: number,
  lobby: LobbyView | null = null,
): void {
  if (!built) return;
  lobbyView = phase === 'lobby' && lobby?.isHost ? lobby : null;
  const inSetup =
    phase === 'modeSelect' || phase === 'players' || phase === 'ai' || !!lobbyView;
  root.hidden = !inSetup;
  document.body.classList.toggle('is-setup', inSetup);
  seatCapacity = playersMax;
  if (!inSetup) {
    lastPhase = phase;
    return;
  }

  const onMode = phase === 'modeSelect';
  root.dataset.screen = onMode ? 'mode' : 'setup';
  root.dataset.mode = lobbyView ? 'online' : phase === 'ai' ? 'ai' : 'hotseat';
  modeScreen.hidden = !onMode;
  setupScreen.hidden = onMode;
  // Mode select has nothing to start yet — its action row is just Back.
  startBtn.hidden = onMode;

  if (phase !== 'modeSelect') {
    // Entering the setup screen: always open on Lineup, and hand the editor a
    // fresh copy of the current rules (turn limit only shown in a host's
    // online lobby, per rules-editor.ts).
    if (lastPhase !== phase) {
      rulesEditor.open(handlers.getRules(), !!lobbyView, handlers.onRulesChange);
      showTab('lineup');
    }
    renderLineup();
  }
  lastPhase = phase;
}
