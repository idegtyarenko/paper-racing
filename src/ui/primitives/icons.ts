// The app's inline SVG icon set: every glyph the redesigned chrome draws, as a
// pre-composed markup string. Pure data — no DOM, no imports — so any module can
// pull one in without dragging the chrome builders along. Paired with `icon()`
// in pr-chrome.ts, which wraps a string in a span.
//
// House shape, worth keeping to: viewBox="0 0 24 24", fill="none",
// stroke="currentColor" so the icon takes the colour of its surroundings,
// rounded caps and joins, and a stroke-width picked per glyph — thin outline
// marks sit at 1.4–1.8, bold action marks at 2–2.4. No class or id on the
// <svg>: sizing belongs to the wrapper's CSS (`.pr-btn__ico svg` and kin).
//
// Before drawing a new one, look here first — the set already covers most of
// what a screen needs, and a second hand-drawn arrow is how a set stops looking
// like a set.

export const BURGER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
export const BACK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H6M11 6l-6 6 6 6"/></svg>';
export const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
export const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
export const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
export const RULES_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.1 9.5a2.9 2.9 0 1 1 4.4 2.5c-1 .6-1.5 1.1-1.5 2.1"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/></svg>';
/** Globe with meridians — the online mode card and "join by code". */
export const GLOBE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/></svg>';
/** Two offset sheets — "copy to clipboard", on the room-code button. */
export const COPY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
/** Three linked nodes — the share sheet / invite link. */
export const SHARE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>';
/** Flag on a pole — retiring from the race (the menu's mid-race entry). */
export const FLAG_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v18"/><path d="M6 4h11l-2.4 4L17 12H6z"/></svg>';
/** Stopwatch — turns still to sit out after a crash (the classification's pit slot). */
export const CLOCK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.6M9 3h6"/></svg>';
/** Burst — how many times this car has been off into the gravel. */
export const CRASH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.2 4.2L19 5.6l-1.4 4.6 4.4 1.8-4.4 1.8L19 18.4l-4.8-1.6L12 21l-2.2-4.2L5 18.4l1.4-4.6L2 12l4.4-1.8L5 5.6l4.8 1.6z"/></svg>';
export const LANG_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>';
/** Tick — the selected language, and "Go!" on the confirm-move button. */
export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 6.5"/></svg>';
/** Pencil at an angle — the editor's coach-mark bullet. */
export const PENCIL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M14.5 6.5l3 3"/></svg>';
/** Triangle with a bang — the failure skin on toasts. */
export const WARN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4L2.5 20h19z"/><path d="M12 10v4"/><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none"/></svg>';
/** Boxy head with an antenna — marks a bot in the classification. */
export const BOT_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.2" r="1.2"/><path d="M9 13v1.5M15 13v1.5"/></svg>';
/** Arrow into a bar — skip a stalling player's turn. */
export const SKIP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6l8 6-8 6zM18 5v14"/></svg>';
/** Circular arrow — run the race back, and retry a move that failed to send. */
/** Filled play triangle — watching the finished race back. Solid on purpose:
 *  an outlined one at 13px (the small button) reads as a stray arrowhead. */
export const PLAY_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5.4v13.2a.8.8 0 0 0 1.22.68l10.5-6.6a.8.8 0 0 0 0-1.36L9.22 4.72A.8.8 0 0 0 8 5.4Z"/></svg>';
export const REMATCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 3 6.7M3 20v-4h4"/></svg>';
/** The same arrow the other way — wipe the drawn track and start it over. */
export const UNDO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 0-3 6.7M21 20v-4h-4"/></svg>';

/** Laurel cup — you won. */
export const TROPHY_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v1.5a3.5 3.5 0 0 0 3.4 3.5M17 6h3v1.5a3.5 3.5 0 0 1-3.4 3.5M9 19h6M8.5 21h7M12 15v4"/></svg>';
/** Chequered flag — a piece of the finish-line confetti. Filled squares rather
 *  than an outline: at confetti size (14–26px) an outlined chequer turns to mush. */
export const CHEQUER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h14v10H5z"/><path d="M5 4h4.7v3.3H5zM14.3 4H19v3.3h-4.7zM9.7 7.3h4.6v3.4H9.7zM5 10.7h4.7V14H5zM14.3 10.7H19V14h-4.7z" fill="currentColor" stroke="none"/></svg>';
/** Champagne bottle — a piece of the finish-line confetti. Read at 20px it is
 *  the proportions that carry it: a long neck, shoulders sloping wide, and the
 *  foil collar. A cork in mid-air was tried and merges into a blob at this
 *  size — the details have to be few and far apart. */
export const CHAMPAGNE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 3.2h3v6c0 1.8 2.7 2.7 2.7 5V19a2.6 2.6 0 0 1-2.6 2.6h-3.2A2.6 2.6 0 0 1 7.8 19v-4.8c0-2.3 2.7-3.2 2.7-5V3.2z"/><path d="M10.1 5.6h3.8"/></svg>';
/** Steering wheel — a piece of the finish-line confetti. */
export const WHEEL_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M4.2 16.5l5.2-3M19.8 16.5l-5.2-3"/></svg>';
/** Podium bars — someone else took it. */
export const PODIUM_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="15" width="6" height="6"/><rect x="9" y="10" width="6" height="11"/><rect x="16" y="17" width="6" height="4"/></svg>';
/** Chip — the mode card for a race against bots. */
export const CHIP_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>';
/** Phone — the mode card for hotseat play on one device. */
export const PHONE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="2.5"/><path d="M11 18h2"/></svg>';
