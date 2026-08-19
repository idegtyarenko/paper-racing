import { describe, it, expect } from 'vitest';
import { GameState } from '../model/game';
import { ringTrack, gameOn } from '../model/test-fixtures';
import { newAppState, AppState } from '../app-state';
import { ScreenInput, raceChromeProps, raceResultProps } from './screen-props';

const track = ringTrack();

function race(players: number, bots = 0): GameState {
  const g = gameOn(track, players);
  for (let i = players - bots; i < players; i++) g.players[i].bot = 'medium';
  return g;
}

/** App state mid-race, plus whichever fields a case cares about. */
function racing(game: GameState, extra: Partial<AppState> = {}): AppState {
  return { ...newAppState(), phase: 'race', game, ...extra };
}

/** `mySeat: null` = local game (hotseat or vs-bots); a number = online. */
function input(state: AppState, mySeat: number | null, extra: Partial<ScreenInput> = {}) {
  return {
    state,
    mySeat,
    net: null,
    connected: true,
    hostGone: false,
    onlineCanRematch: false,
    ...extra,
  };
}

describe('raceChromeProps', () => {
  it('addresses the lone human as "you", but never online or in hotseat', () => {
    expect(raceChromeProps(input(racing(race(4, 3)), null)).soloSeat).toBe(0);
    expect(raceChromeProps(input(racing(race(2)), null)).soloSeat).toBe(-1);
    expect(raceChromeProps(input(racing(race(4, 3)), 0)).soloSeat).toBe(-1);
  });

  it('flags a bot turn so the "tap a point" hint stays down', () => {
    const g = race(3, 2);
    g.current = 1;
    expect(raceChromeProps(input(racing(g), null)).aiTurn).toBe(true);
    g.current = 0;
    expect(raceChromeProps(input(racing(g), null)).aiTurn).toBe(false);
  });

  it('highlights our own row online, and the mover locally', () => {
    const g = race(3);
    g.current = 2;
    expect(raceChromeProps(input(racing(g), 1)).mySeat).toBe(1);
    expect(raceChromeProps(input(racing(g), null)).mySeat).toBe(2);
  });
});

describe('raceResultProps — earlyExit', () => {
  it('is false while the human is still racing', () => {
    expect(raceResultProps(input(racing(race(3, 2)), null)).earlyExit).toBe(false);
  });

  it('vs bots: fires as soon as the one human is done, bots still driving', () => {
    const g = race(3, 2);
    g.players[0].place = 3;
    expect(raceResultProps(input(racing(g), null)).earlyExit).toBe(true);
  });

  it('hotseat: waits for every human sharing the screen', () => {
    const g = race(2);
    g.players[0].retired = true;
    expect(raceResultProps(input(racing(g), null)).earlyExit).toBe(false);
    g.players[1].retired = true;
    expect(raceResultProps(input(racing(g), null)).earlyExit).toBe(true);
  });

  it('online: judged per our own seat, not the other players', () => {
    const g = race(3);
    g.players[1].place = 1;
    expect(raceResultProps(input(racing(g), 0)).earlyExit).toBe(false);
    expect(raceResultProps(input(racing(g), 1)).earlyExit).toBe(true);
  });

  it('online without a seat of our own, never fires', () => {
    const g = race(2);
    g.players[0].place = 1;
    expect(raceResultProps(input(racing(g), -1)).earlyExit).toBe(false);
  });

  it('gives way to `over` once the race has fully resolved', () => {
    const g = race(3, 2);
    g.players[0].place = 3;
    g.phase = 'over';
    const p = raceResultProps(input(racing(g), null));
    expect(p.over).toBe(true);
    expect(p.earlyExit).toBe(false);
  });
});

describe('raceResultProps — the rest', () => {
  it('offers a replay only once somebody has actually driven', () => {
    const g = race(2);
    expect(raceResultProps(input(racing(g), null)).canReplay).toBe(false);
    g.players[0].trail.push({
      from: { x: 0, y: 0 },
      to: { x: 1, y: 0 },
      jump: false,
      turn: 0,
    });
    expect(raceResultProps(input(racing(g), null)).canReplay).toBe(true);
  });

  it('locally offers a rematch only with a lineup saved to repeat', () => {
    const g = race(2);
    expect(raceResultProps(input(racing(g), null)).canRematch).toBe(false);
    const saved = racing(g, {
      lastLocalRace: { humans: 2, bots: 0, difficulty: 'medium' },
    });
    expect(raceResultProps(input(saved, null)).canRematch).toBe(true);
  });

  it('online leaves the rematch to the host', () => {
    const g = race(2);
    expect(raceResultProps(input(racing(g), 1)).canRematch).toBe(false);
    expect(
      raceResultProps(input(racing(g), 1, { onlineCanRematch: true })).canRematch,
    ).toBe(true);
  });

  it('marks a guest by the turn context, and only reports hostGone online', () => {
    const g = race(2);
    const guest = input(racing(g), 1, {
      net: { isHost: false } as ScreenInput['net'],
      hostGone: true,
    });
    expect(raceResultProps(guest).onlineGuest).toBe(true);
    expect(raceResultProps(guest).hostGone).toBe(true);
    // Locally there is no host to leave, whatever the flag says.
    expect(raceResultProps(input(racing(g), null, { hostGone: true })).hostGone).toBe(
      false,
    );
  });
});
