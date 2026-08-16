// The confetti burst: party poppers in all four corners, fired when someone
// wins.
//
// Cut from paper, because the whole game is: most of a burst is limp paper
// ribbon, and every fifth piece is a printed token carrying a racing glyph
// (trophy, chequered flag, steering wheel, champagne). A screenful of icons
// reads as a menu falling over; paper with the odd token in it reads as
// confetti.
//
// The ribbons are jointed rather than flat. Each one is a chain of nested
// segments, every segment hinged on the bottom edge of the one above it and
// swinging a little out of phase — so the bend travels down the strip and the
// paper flutters instead of sailing past like a playing card. The joints are
// the reason a piece is a chain of elements and not a single span.
//
// Each piece is also a flat object in space: it tumbles about a random 3D axis
// under perspective, turning edge-on and all but vanishing twice a second,
// while a fixed light-to-shadow gradient on its faces gets swept through by the
// tumble. That pair — the vanish and the sweep — is what makes paper read as
// paper.
//
// DOM plus CSS keyframes, deliberately: the app has exactly one rAF ticker
// (view/anim.ts) and the result screen is where the replay borrows it, so a
// celebration that also wanted frames would have to take turns with it. The
// trajectory is split across two nested elements — the outer carries the
// horizontal travel (decelerating, as air drag does), the inner the rise and
// the fall (gravity). One element cannot do both: a single transform would
// interpolate the two axes on the same curve, which is the straight diagonal
// line that gives cheap confetti away.
//
// The colours are the cars' own — the field that just raced, not a generic
// party palette.

import { el, icon } from './pr-chrome';
import { prefersReducedMotion } from '../view/anim';
import { CHAMPAGNE_SVG, CHEQUER_SVG, TROPHY_SVG, WHEEL_SVG } from './icons';

const SHAPES = [TROPHY_SVG, CHEQUER_SVG, WHEEL_SVG, CHAMPAGNE_SVG];
const PIECES = 68;
/** One printed token per this many pieces; the rest is paper ribbon. */
const TOKEN_EVERY = 5;
/** Longest a piece can be in the air (delay + flight), ms — when to sweep up. */
const LIFETIME_MS = 3800;

let sweepTimer = 0;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Hang `joints` more segments off `head`, each hinged on the one above it and
 * lagging it slightly, so the flutter runs down the ribbon as a wave. Nested,
 * not siblings: a hinge is only a hinge if it carries everything below it.
 */
function addJoints(head: HTMLElement, joints: number, flutter: number): void {
  let parent = head;
  for (let j = 0; j < joints; j++) {
    const seg = el('span', 'pr-confetti__seg', parent);
    seg.style.animationDuration = `${flutter.toFixed(2)}s`;
    // Negative, so the segment starts mid-swing rather than winding up first.
    seg.style.animationDelay = `${(-0.11 * (j + 1)).toFixed(2)}s`;
    parent = seg;
  }
}

/**
 * Fill `layer` with a fresh burst. Replaces whatever is in there — a second
 * race's celebration must not land on top of the first one's leftovers.
 */
export function burstConfetti(layer: HTMLElement, colors: string[]): void {
  clearConfetti(layer);
  // The player asked their system for less motion, and nothing here is
  // information — it's decoration by definition.
  if (prefersReducedMotion()) return;

  for (let i = 0; i < PIECES; i++) {
    const token = i % TOKEN_EVERY === 0;
    // Four poppers, one per corner, alternating so they all go off together.
    // The ceiling pair is the smaller half: paper coming down needs the room
    // above the screen, paper going up gets the arc.
    const fromLeft = i % 2 === 0;
    const fromTop = i % 5 >= 3;

    const piece = el(
      'span',
      `pr-confetti__piece${fromTop ? ' pr-confetti__piece--top' : ''}`,
      layer,
    );
    // Every so often a plain white scrap. It carries the paper idea, and it's
    // what keeps a two-car race from being a burst in exactly two colours.
    // The colour is drawn at random rather than cycled by index: `i` steps
    // through the tokens in multiples of TOKEN_EVERY, and with a field whose
    // size shares a factor with it every single token would come out in the
    // same car's colour.
    piece.style.color =
      !token && Math.random() < 0.3
        ? 'rgb(var(--pr-ink-rgb))'
        : colors[Math.floor(Math.random() * colors.length)];
    piece.style.left = `${fromLeft ? rand(1, 12) : rand(88, 99)}%`;
    // Fired inward and across: the far pieces clear the whole screen, the near
    // ones fall back around the popper, and the spread between them is what
    // makes it read as a burst rather than a volley.
    piece.style.setProperty('--pr-cf-dx', `${(fromLeft ? 1 : -1) * rand(6, 88)}vw`);
    // From the floor it's an arc — up hard, then down. From the ceiling it's a
    // shower: barely a kick out of the barrel, then all the way down the glass.
    piece.style.setProperty('--pr-cf-rise', `${fromTop ? rand(1, 11) : rand(26, 84)}vh`);
    piece.style.setProperty(
      '--pr-cf-fall',
      `${fromTop ? rand(70, 118) : rand(10, 38)}vh`,
    );
    // A popper empties in a moment — the stagger is the barrel emptying, not a
    // schedule, so it stays short.
    piece.style.setProperty('--pr-cf-delay', `${Math.round(rand(0, 260))}ms`);
    piece.style.setProperty('--pr-cf-dur', `${rand(1.9, 3).toFixed(2)}s`);

    const fly = el('span', 'pr-confetti__fly', piece);
    const chip = el(
      'span',
      `pr-confetti__chip${token ? ' pr-confetti__chip--token' : ''}`,
      fly,
    );
    // Tumble about a random axis, and never a whole number of half-turns: a
    // piece that lands flat-on every time reads as a spinning sprite.
    chip.style.setProperty('--pr-cf-ax', rand(0.15, 1).toFixed(2));
    chip.style.setProperty('--pr-cf-ay', rand(0.35, 1).toFixed(2));
    chip.style.setProperty('--pr-cf-az', rand(0, 0.45).toFixed(2));
    chip.style.setProperty(
      '--pr-cf-tumble',
      `${(Math.random() < 0.5 ? -1 : 1) * rand(430, 1450)}deg`,
    );

    if (token) {
      // The one rigid piece in the burst — card stock, not ribbon.
      const size = rand(19, 27);
      chip.style.setProperty('--pr-cf-w', `${size.toFixed(1)}px`);
      chip.style.setProperty('--pr-cf-h', `${size.toFixed(1)}px`);
      chip.style.setProperty('--pr-cf-size', `${(size * 0.66).toFixed(1)}px`);
      icon('pr-confetti__ico', SHAPES[(i / TOKEN_EVERY) % SHAPES.length], chip);
    } else {
      // A long ribbon gets more joints than a short scrap — same segment
      // length either way, so every piece bends at about the same rate.
      const long = Math.random() < 0.45;
      const w = long ? rand(3.5, 5.5) : rand(5, 9);
      chip.style.setProperty('--pr-cf-w', `${w.toFixed(1)}px`);
      chip.style.setProperty(
        '--pr-cf-h',
        `${(long ? rand(6, 8) : rand(5, 7)).toFixed(1)}px`,
      );
      addJoints(chip, long ? 3 : 1, rand(0.38, 0.62));
    }
  }

  sweepTimer = window.setTimeout(() => {
    sweepTimer = 0;
    layer.replaceChildren();
  }, LIFETIME_MS);
}

/** Take the pieces down early — the screen is going away. */
export function clearConfetti(layer: HTMLElement): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = 0;
  layer.replaceChildren();
}
