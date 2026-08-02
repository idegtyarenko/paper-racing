// English locale — the DEFAULT language and the canonical shape for all locales.
// `type Strings = typeof en` (see below) is derived from this object, so ru.ts and
// be.ts are checked against it at compile time (every key + function signature must
// match). Written WITHOUT `as const` on purpose: literals widen to `string`, so a
// translation may use any text, not the exact English literal.
//
// Plain strings are strings; strings with substitutions are functions. The bolide
// name array is indexed by player number.
//
// The wizard-step badge is a separate `editor.stepBadge(n, total)` — the step body
// strings carry no parseable prefix (renderEditStatus composes the badge from the
// editor phase, no regex).

/** English ordinal: 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th"… */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const en = {
  app: {
    title: '🏁 Paper Racing',
  },

  editor: {
    // Track-drawing wizard instructions (state machine center→…→ready). Bodies only —
    // the "step N of 4" badge is composed separately from `stepBadge`.
    step: {
      center: 'Draw a full loop track without lifting your finger.',
      adjust: 'Drag the road edges to reshape it. ' + 'When it looks right, tap Next.',
      finish: 'Start/finish placed automatically — tap the track to move it.',
      direction: 'Direction is set — tap the other arrow to flip it, or continue.',
      ready: 'Track ready! Choose a game mode.',
    },
    /** Short step title for the editor's top strip (the coach-mark carries the
     *  full instruction). Rendered in caps by CSS. */
    stepTitle: {
      center: 'Draw track',
      adjust: 'Adjust width',
      finish: 'Start/finish',
      direction: 'Direction',
      ready: 'Ready',
    },
    /** Badge for a wizard step, e.g. "Track: step 2 of 4". */
    stepBadge: (n: number, total: number): string => `Track: step ${n} of ${total}`,
    /** Compact step counter for the top strip, e.g. "Step 2/4" (rendered caps). */
    stepCounter: (n: number, total: number): string => `Step ${n}/${total}`,
    errors: {
      selfCross: "The track can't cross itself\u00A0— draw it again.",
      tooSmall: "That loop's too small\u00A0— draw a bigger one.",
      finishNarrow:
        "It's too narrow here for a start\u00A0— pick another spot, or go back and widen it.",
      finishMiss: 'The start line has to sit on the track.',
    },
    gestureCancelled: "That didn't take\u00A0— try again.",
  },

  // The step navigation shared by track drawing and race preparation
  // (ui/wizard-nav.ts): the desktop rail's heading, short labels for the two
  // steps that aren't editor steps, and the warning for a back-jump that would
  // throw the drawing away.
  wizard: {
    /** Heading of the desktop step rail — what the whole six-step run is for. */
    title: 'Race setup',
    /** Step labels for mode select and race setup (the editor's four come from
     *  `editor.stepTitle`). Short: they sit in a 220px rail. */
    stepMode: 'Mode',
    stepSetup: 'Settings',
    /** Jumping back past the drawing steps discards the track — confirm first. */
    resetWarn: 'Going back that far erases the track you drew.',
    resetYes: 'Erase and go back',
  },

  // Global (burger) menu — reachable from the editor's top-left menu button.
  menu: {
    title: 'Menu',
    rules: 'Rules / How to play',
    join: 'Join online game',
    language: 'Language',
  },

  track: {
    strokeShort: 'Draw it in one stroke, without lifting your finger.',
    notClosed: 'The track has to be a loop\u00A0— close it up.',
    tooNarrow: "The track's too narrow\u00A0— widen it.",
    noStartRoom:
      "There's no room on the grid for the cars to line up\u00A0— pick a wider spot for the start.",
  },

  centerline: {
    selfOverlap: 'Those corners are too tight\u00A0— ease off the sharp angles.',
  },

  players: {
    /** Bolide names by player index — strictly in color order (see COLORS in game.ts). */
    names: ['Red', 'Blue', 'Green', 'Orange', 'Purple', 'Teal'],
    /** Row labels on the lineup tab. */
    humansLabel: 'Humans',
    botsLabel: 'Bots',
    /** Bots row on the hotseat screen: how many grid seats the humans left free. */
    botsWithSeats: (seats: number): string => `Bots · ${seats} seats left`,
    difficultyLabel: 'Bot difficulty',
  },

  // Game-mode step (after the track is ready).
  modeSelect: {
    /** Screen title. */
    title: "Who's playing?",
    /** The three ways to play — title + what it means. */
    local: 'With friends on one device',
    localSub: 'Pass the phone between racers',
    online: 'With friends online',
    onlineSub: 'Host or join a room',
    ai: 'You versus the computer',
    aiSub: 'Race with up to 5\u00A0bots',
  },

  // The race-setup screen shared by the hotseat and vs-computer flows.
  setup: {
    /** Screen title. */
    title: 'Race setup',
    /** Tabs: who's racing / how the cars behave / the rules of the race. */
    tabLineup: 'Lineup',
    tabBehaviour: 'Behaviour',
    tabRules: 'Rules',
    /** The screen's primary action. */
    start: 'Start race',
  },

  // Setup for a game against the computer: number of bots and their skill (there's
  // always exactly one human, on pole).
  aiSelect: {
    /** Bot skill levels. */
    easy: 'Rookie',
    medium: 'Amateur',
    hard: 'Pro',
    /** Row labels. */
    botsLabel: 'Number of bots',
    difficultyLabel: 'Difficulty',
    /** Bot name prefix — marks a bot in cards, status and the finish. */
    botPrefix: '🤖',
  },

  // Race rules and car handling — the strings of the shared rules editor, shown
  // in the setup screen's Behaviour/Rules tabs.
  settings: {
    title: 'Race settings',
    // Aria label for the "?" help button next to each setting.
    helpLabel: 'Show explanation',
    // Tabs of the settings sheet: car handling / race rules.
    tabDrive: 'Car handling',
    tabRules: 'Rules',
    // Car handling (bolide movement model): preset ladder + custom sliders.
    driveModeSports: 'Sports',
    driveModeGt: 'GT',
    driveModeF1: 'F1',
    driveModeClassic: 'Classic',
    driveModeCustom: 'Custom',
    driveExplainSports:
      "The car brakes harder than it accelerates and won't let you brake sharply and " +
      'turn at once\u00A0— realistic racing lines with forgiving grip.',
    driveExplainGt:
      'More grip and braking than a sports car, plus light downforce that tightens ' +
      'fast corners.',
    driveExplainF1:
      'Strong downforce\u00A0— the faster you go, the more grip. Fast corners can be taken ' +
      'almost flat, slow ones stay ordinary.',
    driveExplainClassic:
      'Each turn you can change your speed by one cell vertically and horizontally. ' +
      'The classic pen-and-paper game.',
    driveAccel: 'Acceleration',
    driveBrake: 'Braking',
    driveGrip: 'Grip',
    driveDownforce: 'Downforce',
    penaltyLabel: 'Off-track penalty',
    penaltyHint:
      'Penalty turns for flying off the track. Punish by exit speed (the faster you ' +
      "fly off, the longer you're stuck in the gravel) or by a fixed number of turns.",
    // Penalty type.
    dynamic: 'By exit speed',
    static: 'Fixed',
    // How steeply the dynamic penalty grows with exit speed.
    exponentLabel: 'Severity',
    exponentHint: 'How steeply the penalty grows with exit speed.',
    exponentStandard: 'Standard',
    exponentStrict: 'High',
    // Size of the fixed penalty, in turns.
    staticTurnsLabel: 'Penalty turns',
    staticTurnsHint: 'How many turns the car sits in the gravel after flying off.',
    // Per-turn time limit (online only).
    /** Label above the reachable-cells preview. */
    reachableCells: 'Reachable cells',
    turnLimitLabel: 'Time per turn',
    turnLimitHint:
      'How long each turn gets. If a player takes longer than the limit, the others ' +
      'get the right to skip them.',
    limit30s: '30\u00A0sec',
    limit1m: '1\u00A0min',
    limit2m: '2\u00A0min',
    limit5m: '5\u00A0min',
    done: 'Done',
  },

  // Online mode: lobby, name/code dialogs, statuses and errors.
  online: {
    // Your own name — typed into your roster row in the lobby.
    namePlaceholder: 'Type in your name',
    // Join by code.
    joinByCode: 'Join online game',
    joinTitle: 'Join a race',
    codePlaceholder: 'Race code',
    joinSubmit: 'Join',
    // Lobby.
    lobbyBadge: 'Lobby',
    lobbyGuest: 'Waiting for the track creator to start the race…',
    roomCode: 'Room code',
    trackLabel: 'Track',
    players: (n: number, max: number): string => `Players · ${n}/${max}`,
    /** Badge on the racer who owns the track (and starts the race). */
    hostBadge: 'Host',
    /** Under the roster while nobody else has joined. */
    noGuests: 'Share the room code — no one else has joined yet',
    /** Why "Start race" is disabled: your own name is still empty. */
    enterName: 'Enter your name to continue',
    leaveLobby: 'Leave lobby',
    share: '🔗 Share link',
    copied: 'Link copied',
    codeCopied: 'Code copied',
    waiting: 'Waiting for at least one more racer…',
    you: 'you',
    yourTurn: 'Your turn: pick a direction and hit Go!',
    turnOf: (name: string): string => `${name} is moving. Hold on…`,
    // Player is slow to move — can be skipped (the car coasts straight ahead).
    skippable: (name: string): string =>
      `${name} is taking a while. You can skip the turn\u00A0— the car will coast straight.`,
    // Skip-button prefix; the stuck player's name is appended separately in their
    // own color — to make clear you're skipping someone else's turn, not yours.
    skipTurnBtn: '⏭ Skip turn',
    offline: 'offline',
    // Errors / notifications.
    notFound: 'No race found with that code.',
    full: 'This race is already full (6\u00A0players max).',
    started: 'This race has already started.',
    error: "Couldn't connect. Try again.",
    closed: 'The race has ended or was closed by the track creator.',
    // Sending a move / start (confirm-first: write first, then switch locally).
    sending: 'Sending move…',
    sendFailed: "Couldn't send your move. Check your connection and try again.",
    retrySend: '↻ Send again',
    joining: 'Connecting…',
    starting: 'Starting…',
    startFailed: "Couldn't start the race. Try again.",
    // Guest hint on the online results screen: a rematch is started by the track creator.
    rematchWaiting:
      'The track creator can start a rematch\u00A0— everyone continues on the same track.',
    // Connection-state banner (realtime channel dropped).
    reconnecting: 'Connection lost. Reconnecting…',
    /** Code on the reconnect banner: tap to copy, so the race can be rejoined. */
    raceCode: (code: string): string => `Race code ${code}`,
    // Returning to the last online race after a disconnect/reload.
    resumeTitle: (code: string): string => `Return to race ${code}?`,
    resumeYes: 'Return to race',
    gameGone: 'This race is no longer available.',
  },

  race: {
    driver: (name: string): string => `${name} is moving.`,
    /** Local game, bots on the clock: one stable line for their whole run of
     *  turns, instead of naming each bot as it moves. The animated ellipsis is
     *  added by the chip itself. */
    rivalsMoving: 'Rivals are moving…',
    /** What to do on your turn. One hint for both input kinds: since the
     *  redesign, a desktop click picks a target and Go! commits it, exactly as
     *  on touch. */
    hintPick: 'Pick a point and confirm with Go!',
    finalWarn: ' Try to finish further past the line than your rival.',
    /** Heading of the final classification card on the result screen. Caps by CSS. */
    classification: 'Classification',
    /** Label over the turn-order dots, opening the HUD card. Caps by CSS. */
    upNext: 'Up next',
    /** Speed unit in a classification row (caps by CSS). */
    speedUnit: 'km/h',
    /** Right slot of a row whose driver is past the turn timer and can be skipped. */
    stalled: 'Stalled',
    /** Right slot of a finisher while the others are still driving. */
    finished: (place: number): string => `Finished · ${ordinal(place)}`,
    /** Right slot in the final classification: how many moves this car took. */
    moves: (n: number): string => `${n} ${n === 1 ? 'move' : 'moves'}`,
    /** Right slot of a car that dropped out. Caps by CSS. */
    retired: 'Retired',

    // ── Result screen (every car has finished or retired). ──────────────────
    /** Small label above the outcome. Caps by CSS. */
    raceComplete: 'Race complete',
    /** Outcome headline + subtitle: you won / someone else did / nobody did. */
    youWon: 'You won',
    youWonSub: 'First place\u00A0— nice drive',
    someoneWon: (name: string): string => `${name} wins`,
    someoneWonSub: 'Better luck next time',
    allRetired: 'Everyone retired',
    allRetiredSub: 'No cars finished\u00A0— no result this time',
    earlyExitLabel: 'Your race is done',
    earlyExitTitle: 'What next?',
    earlyExitSub: 'No need to wait for the others\u00A0— start over whenever you like',
    earlyExitHostWait:
      'Wait for the bots to finish\u00A0— leaving now would stall the race for everyone else',
    /** A dead heat for first place. */
    drawTitle: 'Photo finish',
    draw: "Too close to call\u00A0— the photo finish couldn't split them!",
    /** "Retire from race" — a row in the global menu, shown only mid-race. */
    retire: 'Retire from race',
    /** Retire-confirmation dialog title. */
    retireConfirmTitle: 'Retire from the race?',
    /** Confirm button in the retire dialog. */
    retireConfirmYes: 'Retire',
    /** Label/aria for the current-standings strip (F1 style). */
    standingsLabel: 'Standings',
    /** Label for the turn-order strip (who's moving now and who's next). */
    queueLabel: 'Turn order',
    /** Toast when a preselected move ("aim") became impossible after someone's move. */
    preselectCleared: "Your planned move won't work now",
    /** Toast after the PWA auto-updated to a fresh build. */
    updated: 'Updated to the latest version',
  },

  buttons: {
    next: 'Next →',
    back: '← Back',
    redraw: '↺ Redraw',
    chooseMode: 'Choose mode →',
    confirmMove: '✓ Go!',
    // Result-screen actions. No emoji: the redesigned chrome uses inline SVG
    // where it needs a glyph (the rematch button carries one), and these render
    // in caps, where an emoji reads as a smudge.
    sameTrack: 'Rematch',
    sameTrackNewMode: 'Same track, new lineup',
    newTrack: 'Draw a new track',
    cancel: 'Cancel',
    rulesTitle: 'Rules',
    toWheel: 'Got it',
  },

  rules: {
    // Paragraphs separated by \n\n; .rules__text renders them via white-space: pre-line.
    // NBSP ( ) are maintained by scripts/typography.mjs — run `npm run typo`, don't hand-edit.
    body:
      'Paper Racing is a pen-and-paper racing game on graph paper. Draw a loop track and lap it faster than your rivals.\n\n' +
      "Your car rolls with momentum\u00A0— it keeps drifting the same way on its own. Each turn you can only nudge it a little: pick one of the highlighted cells. You can't swerve or stop on a dime, so brake and set up your corners early.\n\n" +
      "Fly off the track and you're stuck in the gravel. The faster you were going, the longer it takes to dig out\u00A0— and once you're free, you start from a standstill.\n\n" +
      "You can't drive through or onto another car: rivals hold their ground, just like in a real race.\n\n" +
      'First one back to the start/finish line wins. And if several cars cross it at almost the same moment, whoever went furthest past the line comes out ahead. 🏁\n\n' +
      'Car handling and off-track penalties can be tuned to taste\u00A0— check the ⚙ settings.',
  },

  install: {
    title: 'Install the game on your home screen',
    /** Android/Chromium text: an install button is available. */
    body: "It'll open full-screen and work offline.",
    action: 'Install',
    /** iOS Safari text: no install button, so we show instructions. */
    iosBefore: 'Tap ',
    iosAfter: ' below, then choose "Add to Home Screen".',
    close: 'Close',
  },
};

/** Canonical shape every locale must satisfy (derived from the English source). */
export type Strings = typeof en;
