// Where the editor's coach-mark sits, and what it points at.
//
// Steps 2–4 talk about a specific part of the track — the road edge, the
// start/finish, the chosen arrow — so the card is pinned to that feature with a
// pointer instead of parking in a fixed zone. Pure geometry: the caller
// (main.ts) has the camera and the DOM measurements, this only decides.
// Same split as the floating "Go!" button in a race (view/input.ts →
// ui/race-chrome.ts).

import { Vec, Polyline, lerp, dist } from '../geometry';
import { EditorState } from '../model/editor';

/** The card's own edge that carries the pointer — the one facing the anchor. */
export type NoseSide = 'top' | 'bottom' | 'left' | 'right';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CoachPlacement {
  /** Card position in board css px (what goes into style.left/top). */
  left: number;
  top: number;
  side: NoseSide;
  /** Pointer offset along that edge, in px from the card's left (or top). */
  nose: number;
}

export interface PlaceCoachOptions {
  /**
   * Points worth pointing at, in board css px — more than one where the step
   * has a choice (either road edge). They compete on the same score, so the one
   * that leaves the card on blank paper wins.
   */
  anchors: Vec[];
  card: { w: number; h: number };
  view: { w: number; h: number };
  /** Chrome the card must not cover: the wizard rail, the action bar. */
  keepOut: Rect[];
  /** Track points (board css px) the card should avoid sitting on. */
  avoid: Vec[];
  /** Clearance between the anchor and the card, in px. */
  gap: number;
  /** Keep-off from the edges of the board. */
  margin: number;
}

/** Centroid of a closed polyline's vertices. */
function centroid(poly: Polyline): Vec {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** The vertex of `poly` farthest from `from`. */
function farthestFrom(poly: Polyline, from: Vec): Vec {
  let best = poly[0];
  let bestD = -1;
  for (const p of poly) {
    const d = dist(p, from);
    if (d > bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * The world points the current step's instruction is about — empty on the steps
 * that talk about the whole board (drawing) and so have nothing to point at.
 *
 * The width step offers two: both road edges are draggable, so both are worth
 * pointing at, and which one wins is decided by where the card can sit. Each is
 * taken at its farthest reach from the middle of the track, the stretch of edge
 * with the most open space beside it — outside the loop for the outer edge, in
 * the infield for the inner one.
 */
export function coachAnchors(ed: EditorState): Vec[] {
  switch (ed.step) {
    case 'adjust': {
      if (!ed.outer || !ed.inner || !ed.center) return [];
      const middle = centroid(ed.center);
      return [farthestFrom(ed.outer, middle), farthestFrom(ed.inner, middle)];
    }
    case 'finish':
      return ed.finish ? [lerp(ed.finish.a, ed.finish.b, 0.5)] : [];
    case 'direction': {
      const chosen = ed.arrows?.find(
        (a) => a.forward.x === ed.forward?.x && a.forward.y === ed.forward?.y,
      );
      return chosen ? [chosen.tip] : [];
    }
    default:
      return [];
  }
}

/**
 * Everything on the board the card should keep off, in world coordinates: the
 * road edges plus whatever the current step put on top of them. The direction
 * step's arrows matter most — the instruction invites a tap on the other one, so
 * burying it under the card makes the step unanswerable.
 */
export function coachAvoid(ed: EditorState): Vec[] {
  const pts: Vec[] = [];
  for (const poly of [ed.outer, ed.inner]) {
    // Every other vertex is dense enough to catch a card laid over the road.
    for (let i = 0; poly && i < poly.length; i += 2) pts.push(poly[i]);
  }
  if (ed.finish) pts.push(ed.finish.a, lerp(ed.finish.a, ed.finish.b, 0.5), ed.finish.b);
  for (const a of ed.arrows ?? []) pts.push(...a.path);
  return pts;
}

const SIDES: NoseSide[] = ['top', 'bottom', 'left', 'right'];
/** How far along its edge the pointer may slide before it stops reading as one. */
const NOSE_INSET = 18;
/** Fractions of the card slid past the anchor — tried in this order. */
const SLIDES = [0.5, 0.3, 0.7, 0.12, 0.88];

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function inside(p: Vec, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? lo : Math.min(hi, Math.max(lo, v));

/**
 * Seat the card next to one of the anchors. Every anchor is tried on every side
 * at a few slides along it; a candidate is scored by how much of the track it
 * covers, and covering chrome (rail, action bar) outweighs any of that. Ties go
 * to the side with the most room, so the card drifts toward the empty half of
 * the board — and, where the step offered a choice of anchor, to the one whose
 * open space the card actually fits into.
 */
export function placeCoach(o: PlaceCoachOptions): CoachPlacement {
  const { card, view, gap, margin } = o;

  let best: CoachPlacement | null = null;
  let bestScore = Infinity;

  for (const anchor of o.anchors) {
    // Sides ranked by the room behind the anchor — the first one to survive
    // scoring wins a tie.
    const room: Record<NoseSide, number> = {
      top: view.h - anchor.y,
      bottom: anchor.y,
      left: view.w - anchor.x,
      right: anchor.x,
    };
    const order = [...SIDES].sort((a, b) => room[b] - room[a]);
    // The road right under the anchor is unavoidable — the card has to sit next
    // to the feature it points at. Score only the rest of the track, so the
    // choice is made on which *other* parts get covered.
    const avoid = o.avoid.filter((p) => dist(p, anchor) > gap * 3);

    for (const side of order) {
      for (const slide of SLIDES) {
        const vertical = side === 'top' || side === 'bottom';
        const left = vertical
          ? anchor.x - card.w * slide
          : side === 'left'
            ? anchor.x + gap
            : anchor.x - gap - card.w;
        const top = vertical
          ? side === 'top'
            ? anchor.y + gap
            : anchor.y - gap - card.h
          : anchor.y - card.h * slide;
        const rect: Rect = {
          x: clamp(left, margin, view.w - card.w - margin),
          y: clamp(top, margin, view.h - card.h - margin),
          w: card.w,
          h: card.h,
        };

        let score = order.indexOf(side) * 0.01;
        for (const k of o.keepOut) if (overlaps(rect, k)) score += 1000;
        for (const p of avoid) if (inside(p, rect)) score += 1;
        // A pointer that had to slide to the very corner of its edge no longer
        // reads as pointing; prefer candidates that didn't need the clamp.
        const along = vertical ? anchor.x - rect.x : anchor.y - rect.y;
        const span = vertical ? card.w : card.h;
        if (along < NOSE_INSET || along > span - NOSE_INSET) score += 20;

        if (score < bestScore) {
          bestScore = score;
          best = {
            left: rect.x,
            top: rect.y,
            side,
            nose: clamp(along, NOSE_INSET, span - NOSE_INSET),
          };
        }
      }
    }
  }
  return best!;
}
