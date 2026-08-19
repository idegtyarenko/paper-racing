import { describe, it, expect } from 'vitest';
import { GameState } from './model/game';
import { ringTrack, gameOn } from './model/test-fixtures';
import { Phase } from './app-state';
import {
  SeatCtx,
  isBotSeat,
  soloHumanSeat,
  myTurn,
  preselectSeat,
  candOwner,
  localHumanSeat,
  canRetire,
} from './seats';

const track = ringTrack();

/** A race with `bots` trailing seats taken by bots (the lineup main.ts builds). */
function race(players: number, bots = 0): GameState {
  const g = gameOn(track, players);
  for (let i = players - bots; i < players; i++) g.players[i].bot = 'medium';
  return g;
}

/** Online: our own seat is `mySeat`. */
const online = (game: GameState, mySeat: number, phase: Phase = 'race'): SeatCtx => ({
  game,
  phase,
  mySeat,
});
/** Local (hotseat or vs-bots): nobody owns a single seat. */
const local = (game: GameState | null, phase: Phase = 'race'): SeatCtx => ({
  game,
  phase,
  mySeat: null,
});

describe('isBotSeat', () => {
  it('is true only for seats a bot took', () => {
    const g = race(3, 2);
    expect(isBotSeat(g, 0)).toBe(false);
    expect(isBotSeat(g, 1)).toBe(true);
    expect(isBotSeat(g, 2)).toBe(true);
  });

  it('is false without a game and past the end of the grid', () => {
    expect(isBotSeat(null, 0)).toBe(false);
    expect(isBotSeat(race(2), 9)).toBe(false);
  });
});

describe('soloHumanSeat', () => {
  it('finds the one human racing against bots', () => {
    expect(soloHumanSeat(race(4, 3))).toBe(0);
  });

  it('is −1 in hotseat: two humans mean there is no single "you"', () => {
    expect(soloHumanSeat(race(2))).toBe(-1);
  });

  it('is −1 without a game', () => {
    expect(soloHumanSeat(null)).toBe(-1);
  });
});

describe('myTurn', () => {
  it('is false while a bot is moving, in every mode', () => {
    const g = race(3, 2);
    g.current = 1;
    expect(myTurn(local(g))).toBe(false);
    expect(myTurn(online(g, 0))).toBe(false);
  });

  it('is true in a local game whenever a human is up (hotseat shares the screen)', () => {
    const g = race(2);
    g.current = 1;
    expect(myTurn(local(g))).toBe(true);
  });

  it('online, is true only on our own seat', () => {
    const g = race(2);
    g.current = 0;
    expect(myTurn(online(g, 0))).toBe(true);
    expect(myTurn(online(g, 1))).toBe(false);
  });

  it('online without a seat of our own, is never our turn', () => {
    const g = race(2);
    expect(myTurn(online(g, -1))).toBe(false);
  });
});

describe('preselectSeat', () => {
  it('gives the lone human their fan during a bot turn', () => {
    const g = race(3, 2);
    g.current = 1;
    expect(preselectSeat(local(g))).toBe(0);
  });

  it('gives us our own seat online, whoever is moving', () => {
    const g = race(3);
    g.current = 2;
    expect(preselectSeat(online(g, 1))).toBe(1);
  });

  it('is off in hotseat — no single "you" to pre-pick for', () => {
    expect(preselectSeat(local(race(2)))).toBe(-1);
  });

  it('is off for a seat serving a gravel penalty, finished or retired', () => {
    const gravel = race(3, 2);
    gravel.players[0].skipTurns = 1;
    expect(preselectSeat(local(gravel))).toBe(-1);

    const done = race(3, 2);
    done.players[0].place = 1;
    expect(preselectSeat(local(done))).toBe(-1);

    const gone = race(3, 2);
    gone.players[0].retired = true;
    expect(preselectSeat(local(gone))).toBe(-1);
  });

  it('is off outside the race — on a setup screen, or once the race is over', () => {
    const g = race(3, 2);
    expect(preselectSeat(local(g, 'players'))).toBe(-1);
    g.phase = 'over';
    expect(preselectSeat(local(g))).toBe(-1);
  });
});

describe('candOwner', () => {
  it('is the mover on our own turn', () => {
    const g = race(2);
    g.current = 1;
    expect(candOwner(local(g))).toBe(1);
  });

  it('has no fan while the mover sits out a gravel penalty', () => {
    const g = race(2);
    g.players[0].skipTurns = 1;
    expect(candOwner(local(g))).toBe(-1);
  });

  it('falls back to the pre-pick seat on someone else’s turn', () => {
    const g = race(3, 2);
    g.current = 1;
    expect(candOwner(local(g))).toBe(0);
  });

  it('online, shows our own seat for pre-picking on the opponent’s turn', () => {
    const g = race(2);
    g.current = 1;
    expect(candOwner(online(g, 0))).toBe(0);
  });

  it('hotseat shares one screen: the fan follows whoever is up', () => {
    const g = race(2);
    g.current = 1;
    expect(candOwner(local(g))).toBe(1);
    g.current = 0;
    expect(candOwner(local(g))).toBe(0);
  });

  it('is −1 once the race is over', () => {
    const g = race(2);
    g.phase = 'over';
    expect(candOwner(local(g))).toBe(-1);
  });
});

describe('localHumanSeat', () => {
  it('is our own seat online', () => {
    expect(localHumanSeat(online(race(3), 2))).toBe(2);
  });

  it('locally, is the current mover when they are human', () => {
    const g = race(2);
    g.current = 1;
    expect(localHumanSeat(local(g))).toBe(1);
  });

  it('locally, is −1 while a bot is moving — there is nobody to retire', () => {
    const g = race(3, 2);
    g.current = 2;
    expect(localHumanSeat(local(g))).toBe(-1);
  });
});

describe('canRetire', () => {
  it('is available mid-race to a human who is still in it', () => {
    expect(canRetire(local(race(2)))).toBe(true);
  });

  it('is gone outside the race phase and once the race is over', () => {
    const g = race(2);
    expect(canRetire(local(g, 'lobby'))).toBe(false);
    g.phase = 'over';
    expect(canRetire(local(g))).toBe(false);
  });

  it('is gone for a player who already finished or retired', () => {
    const done = race(2);
    done.players[0].place = 1;
    expect(canRetire(local(done))).toBe(false);

    const gone = race(2);
    gone.players[0].retired = true;
    expect(canRetire(local(gone))).toBe(false);
  });

  it('is gone while a bot is moving locally, but stays for our own seat online', () => {
    const g = race(3, 2);
    g.current = 1;
    expect(canRetire(local(g))).toBe(false);
    expect(canRetire(online(g, 0))).toBe(true);
  });
});
