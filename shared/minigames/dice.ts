// Liar's dice: everyone rolls in secret, then takes turns bidding on how many dice of one face are on the
// whole table, or calling "Liar!" on the bid before. Whoever is wrong loses a die; the last with dice wins.
// Rules only: no browser or server code in this file.

export const DICE_MIN = 2;
export const DICE_MAX = 8;
export const DICE_START = 5;
/** How long a player has to bid or call before the game does it for them. */
export const TURN_MS = 30_000;
/** How long everyone looks at the shown dice between rounds. */
export const REVEAL_MS = 7_000;
export const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

export interface DiceBid {
  /** "At least `n` dice show `face`." */
  n: number;
  face: number;
  /** Who made it. The name is kept in case they leave before it is called. */
  by: string;
  name: string;
}

/** What is shown to everyone after "Liar!". */
export interface DiceReveal {
  hands: { id: string; name: string; dice: number[] }[];
  bid: DiceBid;
  /** How many dice really showed the face. */
  count: number;
  caller: { id: string; name: string };
  /** The bid was true, so the caller was wrong. */
  truth: boolean;
  /** Who lost a die. Null if the bidder had already left. */
  loser: { id: string; name: string } | null;
}

export interface DiceGame {
  /** Who is playing, in the order they joined. `dice` is secret; `count` is public. */
  players: { id: string; name: string; dice: number[]; count: number }[];
  phase: 'lobby' | 'bid' | 'reveal';
  round: number;
  /** Whose turn it is to bid or call. */
  turn: string | null;
  bid: DiceBid | null;
  /** When the turn (or the reveal) runs out (server clock). */
  until: number;
  reveal: DiceReveal | null;
  /** Who opens the next round. */
  starter: string | null;
  /** Who won the last game, shown in the lobby. */
  winner: { id: string; name: string } | null;
}

export const newDice = (): DiceGame => ({ players: [], phase: 'lobby', round: 0, turn: null, bid: null, until: 0, reveal: null, starter: null, winner: null });

export const diceTotal = (g: DiceGame) => g.players.reduce((s, p) => s + p.count, 0);
const alive = (g: DiceGame) => g.players.filter((p) => p.count > 0);

/** The first player still holding dice at or after index `from`, going round in join order. */
function nextAlive(g: DiceGame, from: number): string | null {
  for (let k = 0; k < g.players.length; k++) {
    const p = g.players[(from + k) % g.players.length];
    if (p.count > 0) return p.id;
  }
  return null;
}

/** Is "n of face" a legal bid over `bid` with `total` dice on the table? Takes anything: the browser's word is not trusted. */
export function diceLegal(bid: { n: number; face: number } | null, total: number, n: unknown, face: unknown): boolean {
  if (typeof n !== 'number' || typeof face !== 'number' || !Number.isInteger(n) || !Number.isInteger(face)) return false;
  // Nobody may bid more dice than exist: it keeps the picker finite and a silly bid from dragging on.
  if (face < 1 || face > 6 || n < 1 || n > total) return false;
  return !bid || n > bid.n || (n === bid.n && face > bid.face);
}

/** The smallest legal raise, or null when the only thing left to do is call. */
export function diceLowest(bid: { n: number; face: number } | null, total: number): { n: number; face: number } | null {
  const low = !bid ? { n: 1, face: 1 } : bid.face < 6 ? { n: bid.n, face: bid.face + 1 } : { n: bid.n + 1, face: 1 };
  return diceLegal(bid, total, low.n, low.face) ? low : null;
}

/** Joining is only possible between games. */
export function diceJoin(g: DiceGame, p: { id: string; name: string }): boolean {
  if (g.phase !== 'lobby' || g.players.length >= DICE_MAX || g.players.some((x) => x.id === p.id)) return false;
  g.players.push({ id: p.id, name: p.name, dice: [], count: 0 });
  return true;
}

function startRound(g: DiceGame, now: number, rnd: () => number) {
  for (const p of g.players) p.dice = Array.from({ length: p.count }, () => 1 + Math.floor(rnd() * 6));
  const s = g.players.find((p) => p.id === g.starter);
  g.turn = s && s.count > 0 ? s.id : nextAlive(g, 0);
  g.round++;
  g.bid = g.reveal = null;
  g.phase = 'bid';
  g.until = now + TURN_MS;
}

/** Back to the lobby. Whoever still has dice (if anyone) has won. */
function endGame(g: DiceGame) {
  const last = alive(g)[0];
  g.winner = last ? { id: last.id, name: last.name } : null;
  for (const p of g.players) Object.assign(p, { dice: [], count: 0 });
  Object.assign(g, { phase: 'lobby', turn: null, bid: null, reveal: null, starter: null });
}

/** Anyone in the game can start it. */
export function diceStart(g: DiceGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase !== 'lobby' || g.players.length < DICE_MIN || !g.players.some((p) => p.id === by)) return false;
  for (const p of g.players) p.count = DICE_START;
  g.round = 0;
  g.winner = null;
  g.starter = g.players[0].id;
  startRound(g, now, rnd);
  return true;
}

export function diceBid(g: DiceGame, by: string, n: unknown, face: unknown, now: number): boolean {
  if (g.phase !== 'bid' || g.turn !== by || !diceLegal(g.bid, diceTotal(g), n, face)) return false;
  const i = g.players.findIndex((p) => p.id === by);
  g.bid = { n: n as number, face: face as number, by, name: g.players[i].name };
  g.turn = nextAlive(g, i + 1);
  g.until = now + TURN_MS;
  return true;
}

/** Call the last bid. Everything is shown, and whoever was wrong loses a die. */
export function diceLiar(g: DiceGame, by: string, now: number): boolean {
  if (g.phase !== 'bid' || g.turn !== by || !g.bid) return false;
  const bid = g.bid;
  const caller = g.players.find((p) => p.id === by)!;
  const count = g.players.reduce((s, p) => s + p.dice.filter((d) => d === bid.face).length, 0);
  const truth = count >= bid.n;
  // The bidder may have left since bidding: then a false bid costs nobody a die.
  const loser = truth ? caller : g.players.find((p) => p.id === bid.by) ?? null;
  g.reveal = {
    hands: alive(g).map((p) => ({ id: p.id, name: p.name, dice: [...p.dice] })),
    bid,
    count,
    caller: { id: caller.id, name: caller.name },
    truth,
    loser: loser && { id: loser.id, name: loser.name },
  };
  if (loser) loser.count--;
  // The loser opens the next round; if that was their last die, the next player still in does.
  const from = loser ?? caller;
  g.starter = from.count > 0 ? from.id : nextAlive(g, g.players.indexOf(from) + 1);
  g.phase = 'reveal';
  g.turn = null;
  g.until = now + REVEAL_MS;
  return true;
}

/** Someone left the game or the room: they go, with their dice, and the game carries on if it can. */
export function diceLeave(g: DiceGame, id: string, now: number): boolean {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return false;
  g.players.splice(i, 1);
  if (g.phase === 'lobby') return true;
  // After the splice, index i is the player who sat after the one who left.
  if (g.starter === id) g.starter = nextAlive(g, i);
  if (g.phase === 'bid') {
    if (alive(g).length < DICE_MIN) endGame(g);
    else if (g.turn === id) {
      g.turn = nextAlive(g, i);
      g.until = now + TURN_MS;
    }
  }
  // During a reveal the tick decides what happens next, once the pause is over.
  return true;
}

/** Time passing: an idle turn is played for the player, and a reveal gives way to the next round or the end. */
export function diceTick(g: DiceGame, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'lobby' || now < g.until) return false;
  if (g.phase === 'reveal') {
    if (alive(g).length < DICE_MIN) endGame(g);
    else startRound(g, now, rnd);
    return true;
  }
  if (!g.turn) return false;
  return g.bid ? diceLiar(g, g.turn, now) : diceBid(g, g.turn, 1, 1, now);
}

/** What everyone may see. No dice in here until the reveal. */
export interface DiceView {
  players: { id: string; name: string; count: number }[];
  phase: DiceGame['phase'];
  round: number;
  turn: string | null;
  bid: DiceBid | null;
  /** Dice on the table: the most anyone may bid. */
  total: number;
  /** Milliseconds left in the turn or the reveal. */
  left: number;
  reveal: DiceReveal | null;
  winner: string | null;
  /** The receiver's own dice. Only in the copy sent privately to that player. */
  mine?: number[];
}

export const diceView = (g: DiceGame, now: number): DiceView => ({
  players: g.players.map((p) => ({ id: p.id, name: p.name, count: p.count })),
  phase: g.phase,
  round: g.round,
  turn: g.turn,
  bid: g.bid,
  total: diceTotal(g),
  left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
  reveal: g.phase === 'reveal' ? g.reveal : null,
  winner: g.winner?.name ?? null,
});

/** The view for one player: the public one plus their own dice and nobody else's. */
export function diceViewFor(g: DiceGame, now: number, id: string): DiceView {
  const p = g.players.find((x) => x.id === id);
  return { ...diceView(g, now), mine: p && g.phase === 'bid' ? [...p.dice] : [] };
}

/** What a browser may send. */
export type DiceAction = { k: 'join' } | { k: 'leave' } | { k: 'start' } | { k: 'bid'; n: number; face: number } | { k: 'liar' };
