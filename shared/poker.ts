// Texas Hold'em with play chips. Pure rules over a plain state object; the server runs them.
import { newDeck, type Card } from './cards';

export const SMALL_BLIND = 10;
export const BIG_BLIND = 20;
export const BUY_IN = 1000;

export const POKER_RULES = [
  "Texas Hold'em, for fun: the chips are not worth anything.",
  `Everyone starts with ${BUY_IN.toLocaleString('en-US')} chips. Blinds are ${SMALL_BLIND} and ${BIG_BLIND}.`,
  'You get two cards. Five more are dealt face up for everyone to share.',
  'Best five-card hand from your two and the shared five wins the pot.',
  `Run out of chips and you get a fresh ${BUY_IN.toLocaleString('en-US')} next hand.`,
];

// ------------------------------------------------------------ hand ranking

const RANK_ORDER = '23456789TJQKA';
const value = (c: Card) => RANK_ORDER.indexOf(c[0]) + 2;

export const HAND_NAMES = [
  'high card',
  'a pair',
  'two pair',
  'three of a kind',
  'a straight',
  'a flush',
  'a full house',
  'four of a kind',
  'a straight flush',
];

/** Highest card of the best straight in a set of ranks (5 for the A-2-3-4-5 wheel), or 0. */
function straightHigh(ranks: Set<number>): number {
  for (let high = 14; high >= 5; high--) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      const r = high - k === 1 ? 14 : high - k;
      if (!ranks.has(r)) {
        ok = false;
        break;
      }
    }
    if (ok) return high;
  }
  return 0;
}

/** Score the best five-card hand in up to seven cards: [category, tiebreakers...]. Bigger is better. */
export function scoreHand(cards: Card[]): number[] {
  const values = cards.map(value).sort((a, b) => b - a);
  const count = new Map<number, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  const bySuit = new Map<string, number[]>();
  for (const c of cards) bySuit.set(c[1], [...(bySuit.get(c[1]) ?? []), value(c)]);
  const flush = [...bySuit.values()].find((v) => v.length >= 5)?.sort((a, b) => b - a);

  if (flush) {
    const sf = straightHigh(new Set(flush));
    if (sf) return [8, sf];
  }
  // Ranks grouped by how many of each, highest first within a group.
  const ofCount = (n: number) => [...count].filter(([, c]) => c === n).map(([v]) => v).sort((a, b) => b - a);
  const quads = ofCount(4);
  const trips = ofCount(3);
  const pairs = ofCount(2);
  const kickers = (exclude: number[], n: number) => [...new Set(values)].filter((v) => !exclude.includes(v)).slice(0, n);

  if (quads.length) return [7, quads[0], ...kickers([quads[0]], 1)];
  if (trips.length && (trips.length > 1 || pairs.length)) return [6, trips[0], Math.max(trips[1] ?? 0, pairs[0] ?? 0)];
  if (flush) return [5, ...flush.slice(0, 5)];
  const straight = straightHigh(new Set(values));
  if (straight) return [4, straight];
  if (trips.length) return [3, trips[0], ...kickers([trips[0]], 2)];
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)];
  if (pairs.length) return [1, pairs[0], ...kickers([pairs[0]], 3)];
  return [0, ...values.slice(0, 5)];
}

export function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// ------------------------------------------------------------ the game

export interface PokerSeat {
  id: string;
  name: string;
  chips: number;
  /** Put in during the current betting round. */
  bet: number;
  /** Put in during the whole hand. */
  committed: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  hole: Card[];
}

export interface PokerGame {
  phase: 'lobby' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  seats: PokerSeat[];
  dealer: number;
  dealerId: string | null;
  turn: number;
  board: Card[];
  deck: Card[];
  currentBet: number;
  minRaise: number;
  /** Chips each person has, kept between hands and while they are away from the table. */
  bank: Record<string, number>;
  results: string[];
  /** Whether hole cards are turned over (a real showdown, not everyone folding). */
  shown: boolean;
}

export type PokerAction = { k: 'deal' } | { k: 'fold' } | { k: 'call' } | { k: 'raise'; to: number };

export const newPoker = (): PokerGame => ({
  phase: 'lobby',
  seats: [],
  dealer: -1,
  dealerId: null,
  turn: -1,
  board: [],
  deck: [],
  currentBet: 0,
  minRaise: BIG_BLIND,
  bank: {},
  results: [],
  shown: false,
});

export const betting = (g: PokerGame) => g.phase !== 'lobby' && g.phase !== 'showdown';
export const potOf = (g: PokerGame) => g.seats.reduce((sum, s) => sum + s.committed, 0);
const canAct = (s: PokerSeat) => !s.folded && !s.allIn;

function pay(s: PokerSeat, amount: number) {
  const paid = Math.min(amount, s.chips);
  s.chips -= paid;
  s.bet += paid;
  s.committed += paid;
  if (s.chips === 0) s.allIn = true;
}

/** The next seat after `from` that still owes a decision this round, or -1 if the round is over. */
function nextToAct(g: PokerGame, from: number): number {
  const n = g.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    const s = g.seats[i];
    if (canAct(s) && (!s.acted || s.bet < g.currentBet)) return i;
  }
  return -1;
}

/** Deal a new hand to the people seated. Needs two or more, and no hand in progress. */
export function pokerStart(g: PokerGame, players: { id: string; name: string }[]): boolean {
  if (betting(g) || players.length < 2) return false;
  g.seats = players.map((p) => {
    let chips = g.bank[p.id] ?? BUY_IN;
    if (chips < BIG_BLIND) chips = BUY_IN; // busted: start again
    g.bank[p.id] = chips;
    return { id: p.id, name: p.name, chips, bet: 0, committed: 0, folded: false, allIn: false, acted: false, hole: [] };
  });
  const n = g.seats.length;
  g.deck = newDeck();
  g.board = [];
  g.results = [];
  g.shown = false;
  // The button moves one seat on from whoever had it last.
  g.dealer = (g.seats.findIndex((s) => s.id === g.dealerId) + 1) % n;
  g.dealerId = g.seats[g.dealer].id;
  for (const s of g.seats) s.hole = g.deck.splice(0, 2);

  // Heads-up, the dealer posts the small blind and acts first before the flop.
  const sb = n === 2 ? g.dealer : (g.dealer + 1) % n;
  const bb = (sb + 1) % n;
  pay(g.seats[sb], SMALL_BLIND);
  pay(g.seats[bb], BIG_BLIND);
  g.currentBet = BIG_BLIND;
  g.minRaise = BIG_BLIND;
  g.phase = 'preflop';
  g.turn = nextToAct(g, bb);
  if (g.turn === -1) nextStreet(g);
  return true;
}

function finish(g: PokerGame) {
  g.phase = 'showdown';
  g.turn = -1;
  for (const s of g.seats) g.bank[s.id] = s.chips;
}

function showdown(g: PokerGame) {
  g.shown = true;
  const live = g.seats.filter((s) => !s.folded);
  const score = new Map(live.map((s) => [s.id, scoreHand([...s.hole, ...g.board])]));
  const won = new Map<string, number>();
  // Side pots: each level of commitment is a pot contested by those who put in at least that much.
  const levels = [...new Set(live.map((s) => s.committed))].sort((a, b) => a - b);
  let prev = 0;
  let paid = 0;
  for (const level of levels) {
    // The top pot also takes anything a folded player put in above every live player's level.
    const top = level === levels[levels.length - 1];
    const pot = top ? potOf(g) - paid : g.seats.reduce((sum, s) => sum + Math.max(0, Math.min(s.committed, level) - prev), 0);
    paid += pot;
    const eligible = live.filter((s) => s.committed >= level);
    const best = eligible.reduce((b, s) => (compareScores(score.get(s.id)!, b) > 0 ? score.get(s.id)! : b), [-1]);
    const winners = eligible.filter((s) => compareScores(score.get(s.id)!, best) === 0);
    const share = Math.floor(pot / winners.length);
    winners.forEach((w, i) => {
      const amount = share + (i === 0 ? pot - share * winners.length : 0);
      w.chips += amount;
      won.set(w.id, (won.get(w.id) ?? 0) + amount);
    });
    prev = level;
  }
  g.results = live
    .filter((s) => (won.get(s.id) ?? 0) > 0)
    .map((s) => `${s.name} wins ${won.get(s.id)!.toLocaleString('en-US')} with ${HAND_NAMES[score.get(s.id)![0]]}`);
  finish(g);
}

function nextStreet(g: PokerGame) {
  for (const s of g.seats) {
    s.bet = 0;
    s.acted = false;
  }
  g.currentBet = 0;
  g.minRaise = BIG_BLIND;
  if (g.phase === 'preflop') {
    g.phase = 'flop';
    g.board.push(...g.deck.splice(0, 3));
  } else if (g.phase === 'flop') {
    g.phase = 'turn';
    g.board.push(...g.deck.splice(0, 1));
  } else if (g.phase === 'turn') {
    g.phase = 'river';
    g.board.push(...g.deck.splice(0, 1));
  } else {
    showdown(g);
    return;
  }
  // With at most one person able to bet, there is nothing left to decide: deal it out.
  if (g.seats.filter(canAct).length <= 1) {
    nextStreet(g);
    return;
  }
  g.turn = nextToAct(g, g.dealer);
  if (g.turn === -1) nextStreet(g);
}

function progress(g: PokerGame, from: number) {
  const live = g.seats.filter((s) => !s.folded);
  if (live.length === 1) {
    // Everyone else folded: the pot goes to the last player, cards unseen.
    const pot = potOf(g);
    live[0].chips += pot;
    g.results = [`${live[0].name} wins ${pot.toLocaleString('en-US')}`];
    finish(g);
    return;
  }
  const next = nextToAct(g, from);
  if (next !== -1) g.turn = next;
  else nextStreet(g);
}

/** Apply a player's decision. Returns false if it isn't their turn or the action isn't allowed. */
export function pokerAct(g: PokerGame, pid: string, a: PokerAction): boolean {
  if (!betting(g)) return false;
  const i = g.turn;
  const s = g.seats[i];
  if (!s || s.id !== pid) return false;

  if (a.k === 'fold') {
    s.folded = true;
  } else if (a.k === 'call') {
    pay(s, g.currentBet - s.bet); // nothing owed means this is a check
  } else if (a.k === 'raise') {
    const to = Math.floor(a.to);
    const max = s.bet + s.chips;
    if (!(to > g.currentBet) || to > max) return false;
    // A raise must be at least the last raise, unless it is all the chips you have.
    if (to < g.currentBet + g.minRaise && to !== max) return false;
    const by = to - g.currentBet;
    pay(s, to - s.bet);
    if (by >= g.minRaise) g.minRaise = by;
    g.currentBet = to;
  } else {
    return false;
  }
  s.acted = true;
  progress(g, i);
  return true;
}

/** Someone left the table mid-hand: their hand is folded and what they put in stays in the pot. */
export function pokerLeave(g: PokerGame, pid: string) {
  if (!betting(g)) return;
  const i = g.seats.findIndex((s) => s.id === pid);
  if (i < 0 || g.seats[i].folded) return;
  g.seats[i].folded = true;
  g.seats[i].acted = true;
  g.bank[pid] = g.seats[i].chips;
  if (g.turn === i || g.seats.filter((s) => !s.folded).length === 1) progress(g, g.turn === i ? i : g.turn);
}
