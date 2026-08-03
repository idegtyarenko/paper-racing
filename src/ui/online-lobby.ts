// The guest's online lobby (Blueprint redesign): the room you joined, while the
// track's creator sets the race up. Built here (its owner module) and mounted
// into .app__board on first show, like the other redesigned screens.
//
// Deliberately not the same screen as the host's. The host's lobby IS race setup
// (setup-chrome.ts renders the room inside the Lineup tab, wizard step and all),
// because they still have a race to configure. A guest has nothing to set: they
// see the track they're about to race, the code to pass on, who else is in, and
// a line telling them what's being waited for.

import { EditorState } from '../model/editor';
import { strings } from '../i18n';
import { bindTap } from './dom';
import { render } from '../view/render';
import { polylineBounds } from '../view/camera';
import {
  el,
  button,
  icon,
  buildTopbar,
  buildCode,
  buildRoster,
  buildStatus,
  CodeBlock,
  LobbyView,
  Roster,
  StatusBanner,
} from './pr-chrome';
import { openMenu } from './menu';
import { BURGER_SVG, CLOSE_SVG } from './icons';

const board = document.querySelector('.app__board')!;

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

function build(): void {
  root = el('div', 'pr-layer pr-lobby');
  root.hidden = true;

  buildTopbar(root, {
    iconSvg: BURGER_SVG,
    label: strings.menu.title,
    onTap: openMenu,
  }).title.textContent = strings.online.lobbyBadge;

  const body = el('div', 'pr-lobby__body', root);
  const card = el('div', 'pr-card pr-card--lg pr-scroll-bleed pr-lobby__card', body);

  // The track first: what you're here for, before the plumbing of the room.
  const trackRow = el('div', 'pr-row', card);
  el('span', 'pr-label', trackRow).textContent = strings.online.trackLabel;
  const previewBox = el('div', 'pr-preview pr-lobby__preview', trackRow);
  preview = el('canvas', 'pr-preview__canvas', previewBox);
  new ResizeObserver(() => drawPreview()).observe(previewBox);

  const codeRow = el('div', 'pr-row', card);
  el('span', 'pr-label', codeRow).textContent = strings.online.roomCode;
  code = buildCode(codeRow, {
    onCopy: () => handlers.onLobbyCopyCode(),
    onShare: () => handlers.onLobbyShare(),
  });

  const rosterRow = el('div', 'pr-row', card);
  rosterLabel = el('span', 'pr-label', rosterRow);
  roster = buildRoster(
    rosterRow,
    {
      placeholder: strings.online.namePlaceholder,
      hostBadge: strings.online.hostBadge,
      youBadge: strings.online.you,
      offline: strings.online.offline,
    },
    (name) => handlers.onRename(name),
  );

  const foot = el('div', 'pr-lobby__foot', body);
  status = buildStatus(foot);
  const leaveBtn = button('pr-btn pr-btn--caps pr-lobby__leave', foot);
  icon('pr-btn__ico', CLOSE_SVG, leaveBtn);
  el('span', '', leaveBtn).textContent = strings.online.leaveLobby;
  bindTap(leaveBtn, () => handlers.onLobbyLeave());

  board.append(root);
  built = true;
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
}
