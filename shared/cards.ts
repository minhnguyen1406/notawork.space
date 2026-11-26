// "Last Card": a traditional shedding game in the Crazy Eights family, played with a standard deck.
// Pure rules over a plain state object; the server runs them.

export const SUITS = ['S', 'H', 'D', 'C'] as const;
export type Suit = (typeof SUITS)[number];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'] as const;
/** A card is rank then suit, e.g. "QH" or "TS". */
export type Card = string;

export const rankOf = (c: Card) => c[0];
export const suitOf = (c: Card) => c[1] as Suit;

/** If the player whose turn it is has wandered off, anyone else at the table may skip them after this long. */
export const SKIP_AFTER_MS = 40_000;

export const RULES = [
  'Match the suit or the rank of the top card.',
  '8 is wild: play it on anything and choose the suit.',
  '2 makes the next player draw two, unless they play a 2 to pass it on.',
  'Jack skips the next player. Ace reverses direction.',
  "Can't play? Draw a card. First to empty their hand wins.",
];

export function newDeck(decks = 1): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) out.push(r + s);
  return shuffle(out);
}

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface CardsGame {
  phase: 'play' | 'over';
  /** Player ids in turn order. */
  order: string[];
  names: Record<string, string>;
  hands: Record<string, Card[]>;
  drawPile: Card[];
  discard: Card[];
  /** The suit that must be followed (differs from the top card after an 8). */
  suit: Suit;
  turn: number;
  dir: 1 | -1;
  /** Cards the next player must draw because of 2s. */
  pending: number;
  winner: string | null;
  /** When the current turn began (the caller's clock, in milliseconds). */
  turnSince: number;
}

const SPECIAL = new Set(['2', '8', 'J', 'A']);

export function startCards(players: { id: string; name: string }[], now: number): CardsGame {
  const drawPile = newDeck(players.length > 5 ? 2 : 1);
  const handSize = players.length > 5 ? 5 : 7;
  const hands: Record<string, Card[]> = {};
  const names: Record<string, string> = {};
  for (const p of players) {
    hands[p.id] = drawPile.splice(0, handSize);
    names[p.id] = p.name;
  }
  // Start on a plain card so nobody is hit before the first turn.
  let first = drawPile.findIndex((c) => !SPECIAL.has(rankOf(c)));
  if (first < 0) first = 0;
  const [top] = drawPile.splice(first, 1);
  return {
    phase: 'play',
    order: shuffle(players.map((p) => p.id)),
    names,
    hands,
    drawPile,
    discard: [top],
    suit: suitOf(top),
    turn: 0,
    dir: 1,
    pending: 0,
    winner: null,
    turnSince: now,
  };
}

export const topCard = (g: CardsGame) => g.discard[g.discard.length - 1];
export const currentPlayer = (g: CardsGame) => g.order[g.turn];

export function canPlay(g: CardsGame, card: Card): boolean {
  const rank = rankOf(card);
  if (g.pending > 0) return rank === '2';
  return rank === '8' || suitOf(card) === g.suit || rank === rankOf(topCard(g));
}

function advance(g: CardsGame, steps = 1) {
  const n = g.order.length;
  g.turn = (((g.turn + g.dir * steps) % n) + n) % n;
}

function drawFromPile(g: CardsGame, count: number): Card[] {
  const out: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (g.drawPile.length === 0) {
      // Reshuffle everything under the top card back into the draw pile.
      const top = g.discard.pop()!;
      g.drawPile = shuffle(g.discard);
      g.discard = [top];
      if (g.drawPile.length === 0) break;
    }
    out.push(g.drawPile.pop()!);
  }
  return out;
}

/** Returns true if the play was legal and applied. */
export function playCard(g: CardsGame, pid: string, card: Card, chosen: string | undefined, now: number): boolean {
  if (g.phase !== 'play' || currentPlayer(g) !== pid) return false;
  const hand = g.hands[pid];
  const i = hand.indexOf(card);
  if (i < 0 || !canPlay(g, card)) return false;
  hand.splice(i, 1);
  g.discard.push(card);
  const rank = rankOf(card);
  g.suit = rank === '8' && SUITS.includes(chosen as Suit) ? (chosen as Suit) : suitOf(card);

  g.turnSince = now;
  if (hand.length === 0) {
    g.phase = 'over';
    g.winner = pid;
    return true;
  }
  if (rank === '2') g.pending += 2;
  if (rank === 'A') g.dir = g.dir === 1 ? -1 : 1;
  // A Jack skips; with two players a reverse also comes straight back to you.
  const skip = rank === 'J' || (rank === 'A' && g.order.length === 2);
  advance(g, skip ? 2 : 1);
  return true;
}

/** Draw instead of playing: the owed cards if 2s are pending, otherwise one. The turn then passes. */
export function drawCard(g: CardsGame, pid: string, now: number): boolean {
  if (g.phase !== 'play' || currentPlayer(g) !== pid) return false;
  g.hands[pid].push(...drawFromPile(g, g.pending || 1));
  g.pending = 0;
  advance(g);
  g.turnSince = now;
  return true;
}

/** Milliseconds until someone else may skip the player whose turn it is; 0 when they may, or when the game is over. */
export function cardsSkipIn(g: CardsGame, now: number): number {
  if (g.phase !== 'play') return 0;
  return Math.max(0, g.turnSince + SKIP_AFTER_MS - now);
}

/**
 * Someone else at the table moves the game past a player who has wandered off: allowed once the
 * turn has lasted SKIP_AFTER_MS. The absent player draws (any cards owed for 2s, otherwise one)
 * and the turn passes. `seated` is everyone sitting at the table right now.
 */
export function skipTurn(g: CardsGame, by: string, now: number, seated: readonly string[]): boolean {
  if (g.phase !== 'play') return false;
  const who = currentPlayer(g);
  if (who === undefined || who === by || !Array.isArray(seated) || !seated.includes(by)) return false;
  if (!(now - g.turnSince >= SKIP_AFTER_MS)) return false;
  return drawCard(g, who, now);
}

/** Someone left the table: their cards go under the discard pile. Returns false if the game can't go on. */
export function removePlayer(g: CardsGame, pid: string, now: number): boolean {
  const i = g.order.indexOf(pid);
  if (i < 0) return g.order.length >= 2;
  const wasTurn = i === g.turn;
  if (wasTurn) g.turnSince = now; // the clock starts again for whoever is next
  g.discard.unshift(...(g.hands[pid] ?? []));
  delete g.hands[pid];
  g.order.splice(i, 1);
  if (g.order.length < 2) return false;
  if (i < g.turn) g.turn--;
  else if (wasTurn && g.dir === -1) g.turn--;
  g.turn = ((g.turn % g.order.length) + g.order.length) % g.order.length;
  return true;
}
