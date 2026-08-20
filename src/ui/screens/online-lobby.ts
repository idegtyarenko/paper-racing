// The guest's online lobby (Blueprint redesign): the room you joined, while the
// track's creator sets the race up. Built here (its owner module) and mounted
// into .app__board on first show, like the other redesigned screens.
//
// Deliberately not the same screen as the host's. The host's lobby IS race setup
// (setup-chrome.ts renders the room inside the Lineup tab, wizard step and all),
// because they still have a race to configure. A guest has nothing to set: they
// see the track they're about to race, the code to pass on, who else is in, and
// a line telling them what's being waited for.
//
// They do, however, get the same Behaviour and Rules tabs — read-only. What the
// host picked decides how the guest's car drives and what a crash costs, and
// finding that out by driving into the gravel is a poor way to learn it.

import { EditorState } from '../../model/editor';
import { strings } from '../../i18n';
import { bindTap } from '../primitives/dom';
import { render } from '../../view/render';
import { polylineBounds } from '../../view/camera';
import {
  el,
  button,
  icon,
  buildTopbar,
  buildCode,
  buildRoster,
  buildStatus,
  buildTabs,
  CodeBlock,
  Roster,
  StatusBanner,
  Tabs,
} from '../primitives/pr-chrome';
import { LobbyView } from '../../app-state';
import { mountRulesEditor, RulesEditor } from '../components/rules-editor';
import { openMenu } from '../components/menu';
import { BURGER_SVG, CLOSE_SVG } from '../primitives/icons';

const board = document.querySelector('.app__board')!;

type LobbyTab = 'room' | 'drive' | 'rules';

export interface OnlineLobbyHandlers {
  onLobbyCopyCode: () => void;
  onLobbyShare: () => void;
  onLobbyLeave: () => void;
  /** Our own name, as typed into the roster row. */
  onRename: (name: string) => void;
}

let handlers: OnlineLobbyHandlers;
let built = false;
let root: HTMLElement;
let code: CodeBlock;
let rosterLabel: HTMLElement;
let roster: Roster;
let status: StatusBanner;
let preview: HTMLCanvasElement;
/** The track being previewed, kept so a resize can redraw it. */
let previewEditor: EditorState | null = null;
let tabbar: Tabs<LobbyTab>;
/** The host's settings, shown read-only. A second instance of the same component
 *  the setup screen mounts — it keeps its state in a closure, so two are fine. */
let rulesEditor: RulesEditor;
/** The rules currently loaded into it, so a re-render doesn't reopen the editor
 *  (which would fold every expanded "?" back). Compared by value, not identity:
 *  every incoming row brings a fresh object. */
let shownRules = '';

function build(): void {
  root = el('div', 'pr-layer pr-lobby');
  root.hidden = true;

  buildTopbar(root, {
    iconSvg: BURGER_SVG,
    label: strings.menu.title,
    onTap: openMenu,
  }).title.textContent = strings.online.lobbyBadge;

  const body = el('div', 'pr-lobby__body', root);
  const card = el('div', 'pr-card pr-card--lg pr-lobby__card', body);
  tabbar = buildTabs<LobbyTab>(
    card,
    [
      { key: 'room', label: strings.setup.tabLineup },
      { key: 'drive', label: strings.setup.tabBehaviour },
      { key: 'rules', label: strings.setup.tabRules },
    ],
    showTab,
  );
  const roomPane = tabbar.panes.room;

  // The track first: what you're here for, before the plumbing of the room.
  // The row carries its own class because the whole thing — label included —
  // steps aside on a wide screen, where the board behind shows the same track.
  const trackRow = el('div', 'pr-row pr-lobby__track', roomPane);
  el('span', 'pr-label', trackRow).textContent = strings.online.trackLabel;
  const previewBox = el('div', 'pr-preview pr-lobby__preview', trackRow);
  preview = el('canvas', 'pr-preview__canvas', previewBox);
  new ResizeObserver(() => drawPreview()).observe(previewBox);

  const codeRow = el('div', 'pr-row', roomPane);
  el('span', 'pr-label', codeRow).textContent = strings.online.roomCode;
  code = buildCode(codeRow, {
    onCopy: () => handlers.onLobbyCopyCode(),
    onShare: () => handlers.onLobbyShare(),
  });

  const rosterRow = el('div', 'pr-row', roomPane);
  rosterLabel = el('span', 'pr-label', rosterRow);
  roster = buildRoster(
    rosterRow,
    {
      placeholder: strings.online.namePlaceholder,
      hostBadge: strings.online.hostBadge,
      youBadge: strings.online.you,
      offline: strings.online.offline,
      botBadge: (d) => strings.aiSelect[d],
    },
    (name) => handlers.onRename(name),
  );

  rulesEditor = mountRulesEditor({
    drive: tabbar.panes.drive,
    rules: tabbar.panes.rules,
  });
  tabbar.show('room');

  const foot = el('div', 'pr-lobby__foot', body);
  status = buildStatus(foot);
  // This screen is the *guest's* lobby (main.ts hands the host's view to the
  // setup chrome instead), so leaving really is just freeing a seat — the room
  // outlives it. The host's button is the one that says "Cancel game", and the
  // one that asks for confirmation first.
  const leaveBtn = button('pr-btn pr-btn--caps pr-lobby__leave', foot);
  icon('pr-btn__ico', CLOSE_SVG, leaveBtn);
  el('span', '', leaveBtn).textContent = strings.online.leaveLobby;
  bindTap(leaveBtn, () => handlers.onLobbyLeave());

  board.append(root);
  built = true;
}

function showTab(next: LobbyTab): void {
  tabbar.show(next);
  // The reachable-cells canvas has no width while its pane is hidden, so the
  // render done then drew nothing — redraw once it's on screen.
  if (next === 'drive') requestAnimationFrame(() => rulesEditor.refreshPreview());
}

/**
 * Thumbnail of the host's track, drawn with the same renderer the board uses —
 * a guest's editor state is the host's track (editorFromTrack on join), so this
 * is the real thing scaled down, not a second drawing of it.
 */
function drawPreview(): void {
  const editor = previewEditor;
  if (!editor) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = preview.clientWidth;
  const cssH = preview.clientHeight;
  if (!cssW || !cssH) return; // laid out but not yet sized (hidden pane)
  preview.width = Math.round(cssW * dpr);
  preview.height = Math.round(cssH * dpr);
  const ctx = preview.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bb = polylineBounds(editor.outer, editor.inner, editor.center);
  if (!bb) return;
  // Fitted by hand rather than with camera.fitBounds: that one clamps to
  // SCALE_MIN (the board's zoom-out ceiling, 8px per cell), which a thumbnail
  // this size can't respect — a whole track would hang off every edge.
  const margin = 0.06;
  const bw = Math.max(1e-6, bb.maxX - bb.minX);
  const bh = Math.max(1e-6, bb.maxY - bb.minY);
  const scale = Math.min((cssW * (1 - 2 * margin)) / bw, (cssH * (1 - 2 * margin)) / bh);
  render(ctx, {
    mode: 'edit',
    editor,
    game: null,
    cands: null,
    hover: null,
    selected: null,
    pending: null,
    candSeat: -1,
    loupe: null,
    cam: {
      scale,
      ox: cssW / 2 - ((bb.minX + bb.maxX) / 2) * scale,
      oy: cssH / 2 - ((bb.minY + bb.maxY) / 2) * scale,
    },
  });
}

export function initOnlineLobby(h: OnlineLobbyHandlers): void {
  handlers = h;
  build();
}

/**
 * Render the guest lobby, or hide it (`view` null — we're not a guest in a
 * lobby). `editor` carries the host's track for the thumbnail.
 */
export function renderOnlineLobby(view: LobbyView | null, editor?: EditorState): void {
  if (!built) return;
  root.hidden = !view;
  document.body.classList.toggle('is-lobby', !!view);
  if (!view) return;

  code.set(view.code);
  rosterLabel.textContent = strings.online.players(view.players.length, view.seats);
  roster.render(view.players);
  // The connection is the more urgent of the two: while it's down, nothing we
  // say about the host is worth trusting.
  status.set(
    view.connected ? strings.online.lobbyGuest : strings.online.reconnecting,
    !view.connected,
  );

  if (editor && editor !== previewEditor) {
    previewEditor = editor;
    drawPreview();
  }

  // The settings tabs only exist once the host's settings have arrived: a room
  // created by an older client carries none, and empty tabs would be worse than
  // no tabs. Reopening the editor is skipped while the values are unchanged.
  const hasRules = !!view.rules;
  tabbar.tabs.drive.hidden = !hasRules;
  tabbar.tabs.rules.hidden = !hasRules;
  if (!hasRules) {
    shownRules = '';
    showTab('room');
    return;
  }
  const key = JSON.stringify(view.rules);
  if (key !== shownRules) {
    shownRules = key;
    rulesEditor.open(view.rules!, true, () => {}, true);
  }
}
