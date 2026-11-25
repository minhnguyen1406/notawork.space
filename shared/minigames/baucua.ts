// Bầu cua: the Tết dice game. Everyone bets play chips on six symbols, the house rolls three dice.
// Rules only: no browser or server code in this file.

/** The six faces, in the order they sit on the board (top row, then bottom row). */
export const SYMBOLS = [
  { name: 'Nai', english: 'deer', icon: '🦌' },
  { name: 'Bầu', english: 'gourd', icon: '🍐' },
  { name: 'Gà', english: 'rooster', icon: '🐓' },
  { name: 'Cá', english: 'fish', icon: '🐟' },
  { name: 'Cua', english: 'crab', icon: '🦀' },
  { name: 'Tôm', english: 'shrimp', icon: '🦐' },
] as const;

export const CHIP_SIZES = [10, 50, 100] as const;
export const START_CHIPS = 1000;
export const BAUCUA_MAX = 20;
export const BET_MS = 15_000;
export const SHOW_MS = 6_000;
/** A ceiling on anyone's chips, so a very long lucky streak stays a whole number. */
export const MAX_CHIPS = 1_000_000_000;

export interface BauCuaPlayer {
  id: string;
  name: string;
  /** Stake on each symbol this round, indexed like SYMBOLS. */
  bets: number[];
  /** Won or lost on the last roll; null until the dice have been rolled, or if they had no bet down. */
  net: number | null;
}

export interface BauCuaGame {
  /** Who is at the table, in the order they joined. */
  players: BauCuaPlayer[];
  /** Chips not on the board, for everyone who has played since entering the room (kept when they leave the table). */
  bank: Map<string, number>;
  /** idle: nobody playing. bet: countdown running. wait: nobody bet, so no clock until someone does. show: dice on view. */
  phase: 'idle' | 'bet' | 'wait' | 'show';
  /** When the current phase ends (server clock). Unused while idle or waiting. */
  until: number;
  dice: number[] | null;
  round: number;
  /** Players who had run out and were given a fresh stack at the start of this round. */
  topped: string[];
}

export const newBauCua = (): BauCuaGame => ({ players: [], bank: new Map(), phase: 'idle', until: 0, dice: null, round: 0, topped: [] });

const noBets = () => SYMBOLS.map(() => 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const seat = (g: BauCuaGame, id: string) => g.players.find((p) => p.id === id);
const betting = (g: BauCuaGame) => g.phase === 'bet' || g.phase === 'wait';
export const chipsOf = (g: BauCuaGame, id: string) => g.bank.get(id) ?? START_CHIPS;

/** Anyone at the table with nothing left gets a fresh stack. Only called when they have no bet down. */
function topUp(g: BauCuaGame, id: string) {
  if (chipsOf(g, id) > 0) return;
  g.bank.set(id, START_CHIPS);
  if (!g.topped.includes(id)) g.topped.push(id);
}

function startRound(g: BauCuaGame, now: number) {
  g.round++;
  g.phase = 'bet';
  g.until = now + BET_MS;
  g.dice = null;
  g.topped = [];
  for (const p of g.players) {
    p.bets = noBets();
    p.net = null;
    topUp(g, p.id);
  }
}

/** Sit down at the table. The first person to sit starts the rounds. */
export function baucuaJoin(g: BauCuaGame, p: { id: string; name: string }, now: number): boolean {
  if (seat(g, p.id) || g.players.length >= BAUCUA_MAX) return false;
  g.players.push({ id: p.id, name: p.name, bets: noBets(), net: null });
  if (!g.bank.has(p.id)) g.bank.set(p.id, START_CHIPS);
  if (g.phase === 'idle') startRound(g, now);
  // Someone who left broke and came back mid-round should not have to sit a round out.
  else topUp(g, p.id);
  return true;
}

/** Stand up from the table but stay in the room: chips are remembered. Returns true if anything changed. */
export function baucuaLeave(g: BauCuaGame, id: string): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  // Bets not yet rolled for go back to them; after the roll they are already settled.
  if (betting(g)) g.bank.set(id, chipsOf(g, id) + sum(g.players[i].bets));
  g.players.splice(i, 1);
  g.topped = g.topped.filter((x) => x !== id);
  if (!g.players.length) Object.assign(g, { phase: 'idle', until: 0, dice: null, topped: [] });
  return true;
}

/** Left the room altogether: their chips are forgotten too. Returns true if the table changed. */
export function baucuaGone(g: BauCuaGame, id: string): boolean {
  const changed = baucuaLeave(g, id);
  g.bank.delete(id);
  return changed;
}

/** Stack one chip of size `chip` on symbol `sym`. Both come from a browser, so both are checked. */
export function baucuaBet(g: BauCuaGame, id: string, sym: unknown, chip: unknown, now: number): boolean {
  const p = seat(g, id);
  if (!p || !betting(g)) return false;
  if (typeof sym !== 'number' || !Number.isInteger(sym) || sym < 0 || sym >= SYMBOLS.length) return false;
  if (typeof chip !== 'number' || !(CHIP_SIZES as readonly number[]).includes(chip)) return false;
  const chips = chipsOf(g, id);
  if (chip > chips) return false;
  g.bank.set(id, chips - chip);
  p.bets[sym] += chip;
  // The table was resting because nobody had bet: this bet starts a fresh countdown.
  if (g.phase === 'wait') {
    g.phase = 'bet';
    g.until = now + BET_MS;
  }
  return true;
}

/** Take all of my bets back off the board. */
export function baucuaClear(g: BauCuaGame, id: string): boolean {
  const p = seat(g, id);
  if (!p || !betting(g)) return false;
  const staked = sum(p.bets);
  if (!staked) return false;
  g.bank.set(id, chipsOf(g, id) + staked);
  p.bets = noBets();
  return true;
}

/** What comes back for one stake when its symbol shows on `k` dice: the stake plus k times the stake, or nothing. */
export const payout = (stake: number, k: number) => (k > 0 ? stake * (1 + k) : 0);

/** What a whole set of bets returns for a roll. */
export function settle(bets: number[], dice: number[]): { staked: number; back: number; net: number } {
  const back = sum(bets.map((stake, s) => payout(stake, dice.filter((d) => d === s).length)));
  const staked = sum(bets);
  return { staked, back, net: back - staked };
}

/**
 * Time passing. Returns what happened, if anything:
 * 'roll' the dice were rolled and bets paid, 'skip' betting closed with no bets so the table rests,
 * 'round' a new betting round opened.
 */
export function baucuaTick(g: BauCuaGame, now: number, rnd: () => number = Math.random): 'roll' | 'skip' | 'round' | null {
  if (g.phase === 'bet' && now >= g.until) {
    if (!g.players.some((p) => sum(p.bets) > 0)) {
      g.phase = 'wait';
      g.until = 0;
      return 'skip';
    }
    const dice = [0, 1, 2].map(() => Math.min(SYMBOLS.length - 1, Math.max(0, Math.floor(rnd() * SYMBOLS.length))));
    g.dice = dice;
    for (const p of g.players) {
      const r = settle(p.bets, dice);
      p.net = r.staked ? r.net : null;
      g.bank.set(p.id, Math.min(MAX_CHIPS, chipsOf(g, p.id) + r.back));
    }
    g.phase = 'show';
    g.until = now + SHOW_MS;
    return 'roll';
  }
  if (g.phase === 'show' && now >= g.until) {
    startRound(g, now);
    return 'round';
  }
  return null;
}

/** What everyone sees. Nothing in this game is secret: bets are placed in the open. */
export interface BauCuaView {
  players: {
    id: string;
    name: string;
    /** Chips in hand, not counting what is on the board. */
    chips: number;
    bets: number[];
    net: number | null;
    /** Chips in hand plus bets still waiting for the roll: what the leaderboard ranks by. */
    worth: number;
  }[];
  phase: BauCuaGame['phase'];
  /** Milliseconds left in the betting or showing phase. */
  left: number;
  dice: number[] | null;
  round: number;
  topped: string[];
}

export const baucuaView = (g: BauCuaGame, now: number): BauCuaView => ({
  players: g.players.map((p) => {
    const chips = chipsOf(g, p.id);
    return { id: p.id, name: p.name, chips, bets: p.bets, net: p.net, worth: chips + (betting(g) ? sum(p.bets) : 0) };
  }),
  phase: g.phase,
  left: g.phase === 'bet' || g.phase === 'show' ? Math.max(0, g.until - now) : 0,
  dice: g.dice,
  round: g.round,
  topped: g.topped,
});

/** What a browser may send. */
export type BauCuaAction = { k: 'join' } | { k: 'leave' } | { k: 'bet'; sym: number; chip: number } | { k: 'clear' };
