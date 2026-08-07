// Chrome for the replay: one way out and nothing else.
//
// The replay is watched, not operated — the board underneath is the whole
// screen, and anything floating over it competes with the cars. Play/pause and
// speed are a separate question for when there's a reason to reach for them.
//
// Its own module (built on first show) rather than a corner of race-result.ts:
// the result screen is hidden the whole time this is up, so the two never share
// a frame.

import { el, button, icon } from './pr-chrome';
import { bindTap } from './dom';
import { CLOSE_SVG } from './icons';
import { strings } from '../i18n';

const board = document.querySelector('.app__board')!;

let root: HTMLElement | null = null;

function build(onExit: () => void): HTMLElement {
  const layer = el('div', 'pr-layer pr-replay');
  layer.hidden = true;
  const close = button('pr-btn pr-btn--icon pr-replay__close', layer);
  close.setAttribute('aria-label', strings.buttons.closeReplay);
  icon('pr-btn__ico', CLOSE_SVG, close);
  // bindTap for the same reason the result screen uses it: this button appears
  // right after a tap on another one, and iOS drops that first synthetic click.
  bindTap(close, onExit);
  board.append(layer);
  return layer;
}

/** Show the replay chrome and hand the board over to the replay. */
export function showReplayChrome(onExit: () => void): void {
  root ??= build(onExit);
  root.hidden = false;
  // Takes the result screen and the race HUD off the board (race-result.css).
  document.body.classList.add('is-replay');
}

export function hideReplayChrome(): void {
  if (root) root.hidden = true;
  document.body.classList.remove('is-replay');
}
