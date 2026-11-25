// Tiến lên (southern rules): shed your 13 cards first by beating the play on the table.
// Rules only: no browser or server code in this file.

export const TL_MIN = 2;
export const TL_MAX = 4;
export const TL_HAND = 13;
/** How long a turn lasts before it is played for you. */
export const TURN_MS = 30_000;
/** Southern tables differ on whether four of a kind also chops a PAIR of 2s. Off: only a run of four pairs does. */
export const QUAD_CHOPS_PAIR_OF_TWOS = false;

// A card is a number 0..51 equal to rank * 4 + suit, so a higher number is always a higher card.
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUITS = ['♠', '♣', '♦', '♥'];
const TWO = 12;
export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const cardOf = (rank: number, suit: number) => rank * 4 + suit;
export const cardName = (c: number) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
export const isRed = (c: number) => suitOf(c) >= 2;

export type ComboKind = 'single' | 'pair' | 'triple' | 'quad' | 'straight' | 'pairs';
/** A legal set of cards: what it is, how many cards, and its highest card. `pairs` is a run of consecutive pairs. */
export interface Combo {
  kind: ComboKind;
  n: number;
  top: number;
}

/** What these cards are as a play, or null if they are not a legal play. Treats its input as hostile. */
export function classify(cards: unknown): Combo | null {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > TL_HAND) return null;
  const s = [...(cards as number[])].sort((a, b) => a - b);
  const n = s.length;
  for (let i = 0; i < n; i++) if (!Number.isInteger(s[i]) || s[i] < 0 || s[i] > 51 || (i > 0 && s[i] === s[i - 1])) return null;
  const top = s[n - 1];
  const ranks = s.map(rankOf);
  if (n === 1) return { kind: 'single', n, top };
  if (ranks[0] === ranks[n - 1]) return { kind: n === 2 ? 'pair' : n === 3 ? 'triple' : 'quad', n, top };
  // 2s never take part in a straight or a run of pairs.
  if (ranks[n - 1] === TWO) return null;
  if (n >= 3 && ranks.every((r, i) => r === ranks[0] + i)) return { kind: 'straight', n, top };
  if (n >= 6 && n % 2 === 0 && ranks.every((r, i) => r === ranks[0] + (i >> 1))) return { kind: 'pairs', n, top };
  return null;
}

/** Does play `a` beat `b`, the play on the table? */
export function beats(a: Combo, b: Combo): boolean {
  // The ordinary way: same kind, same number of cards, higher top card (rank, then suit).
  if (a.kind === b.kind && a.n === b.n) return a.top > b.top;
  // Everything else is a chop.
  const run = a.kind === 'pairs' ? a.n / 2 : 0;
  const twos = rankOf(b.top) === TWO;
  if (b.kind === 'single' && twos) return a.kind === 'quad' || run >= 3;
  if (b.kind === 'pair' && twos) return run >= 4 || (QUAD_CHOPS_PAIR_OF_TWOS && a.kind === 'quad');
  if (b.kind === 'triple' && twos) return run >= 5;
  if (b.kind === 'pairs' && b.n === 6) return a.kind === 'quad' || run >= 4;
  if (b.kind === 'quad') return run >= 4;
  return false;
}

export const COMBO_NAMES: Record<ComboKind, string> = {
  single: 'single',
  pair: 'pair',
  triple: 'three of a kind',
  quad: 'four of a kind',
  straight: 'straight',
  pairs: 'run of pairs',
};

export interface TlPlayer {
  id: string;
  name: string;
}

export interface TlGame {
  /** Who is at the table, in seat order (the order they joined). Play goes round in this order. */
  players: TlPlayer[];
  phase: 'lobby' | 'play' | 'ended';
  /** Each player's cards, sorted low to high. Secret. */
  hands: Record<string, number[]>;
  turn: string | null;
  /** The play to beat, or null when the player on turn leads a new trick. */
  table: { by: string; name: string; cards: number[] } | null;
  /** Who has passed in this trick: they are out until it ends. */
  passed: string[];
  /** The opening play of a session must include this card (the lowest dealt: the 3 of spades with four players). */
  mustInclude: number | null;
  /** When the turn times out (server clock). */
  until: number;
  /** Winner of the last hand, who leads the next one. */
  lastWinner: string | null;
  winner: TlPlayer | null;
  /** Cards left in each hand when the hand ended, shown to everyone. */
  reveal: { id: string; name: string; cards: number[] }[] | null;
  /** One line about the last thing that happened, for the panel. */
  note: string | null;
}

export const newTienlen = (): TlGame => ({
  players: [],
  phase: 'lobby',
  hands: {},
  turn: null,
  table: null,
  passed: [],
  mustInclude: null,
  until: 0,
  lastWinner: null,
  winner: null,
  reveal: null,
  note: null,
});

const seated = (g: TlGame, id: string) => g.players.some((p) => p.id === id);

export function tlJoin(g: TlGame, p: TlPlayer): boolean {
  // Nobody sits down in the middle of a hand: they watch until the next deal.
  if (g.phase === 'play' || g.players.length >= TL_MAX || seated(g, p.id)) return false;
  g.players.push({ id: p.id, name: p.name });
  return true;
}

function lead(g: TlGame, id: string, now: number) {
  g.table = null;
  g.passed = [];
  g.turn = id;
  g.until = now + TURN_MS;
}

/** Pass the turn on from seat `from`. Coming back round to whoever owns the table ends the trick. */
function advance(g: TlGame, from: number, now: number) {
  const n = g.players.length;
  for (let i = 1; i <= n; i++) {
    const p = g.players[(from + i) % n];
    if (g.table && p.id === g.table.by) return lead(g, p.id, now);
    if (!g.passed.includes(p.id)) {
      g.turn = p.id;
      g.until = now + TURN_MS;
      return;
    }
  }
  // Everyone passed and the owner of the table has left: the next seat leads.
  lead(g, g.players[(from + 1) % n].id, now);
}

function finish(g: TlGame, winner: TlPlayer, note: string) {
  g.reveal = g.players.map((p) => ({ id: p.id, name: p.name, cards: g.hands[p.id] ?? [] }));
  g.phase = 'ended';
  g.winner = { id: winner.id, name: winner.name };
  g.lastWinner = winner.id;
  g.hands = {};
  g.turn = null;
  g.passed = [];
  g.mustInclude = null;
  g.until = 0;
  g.note = note;
}

/** Whoever holds the lowest card dealt leads, and their first play must include it. */
function openWithLowest(g: TlGame, now: number) {
  let low = 52;
  let who = g.players[0].id;
  for (const p of g.players) {
    const c = g.hands[p.id][0];
    if (c < low) {
      low = c;
      who = p.id;
    }
  }
  lead(g, who, now);
  g.mustInclude = low;
}

/** Start a hand from `g.hands` (already dealt). Split from tlDeal so tests can set up exact hands. */
export function tlBegin(g: TlGame, now: number) {
  for (const p of g.players) g.hands[p.id].sort((a, b) => a - b);
  g.phase = 'play';
  g.winner = null;
  g.reveal = null;
  g.note = null;
  g.mustInclude = null;
  // First hand of a session (or the winner has gone): lowest card leads. Later hands: the winner leads anything.
  if (g.lastWinner && seated(g, g.lastWinner)) lead(g, g.lastWinner, now);
  else openWithLowest(g, now);
}

/** Shuffle and deal 13 cards each. `rnd` is injectable so tests are repeatable. */
export function tlDeal(g: TlGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase === 'play' || !seated(g, by) || g.players.length < TL_MIN || g.players.length > TL_MAX) return false;
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  g.hands = {};
  g.players.forEach((p, i) => (g.hands[p.id] = deck.slice(i * TL_HAND, (i + 1) * TL_HAND)));
  tlBegin(g, now);
  return true;
}

/** Why these cards cannot be played by `by` right now, or null if they can. Shared with the browser to enable Play. */
export function tlIllegal(hand: readonly number[], table: readonly number[] | null, mustInclude: number | null, cards: unknown): string | null {
  const combo = classify(cards);
  if (!combo) return 'Not a legal set of cards.';
  const picked = cards as number[];
  if (!picked.every((c) => hand.includes(c))) return 'You do not hold those cards.';
  if (table) {
    const t = classify(table);
    if (!t || !beats(combo, t)) return 'That does not beat the table.';
  } else if (mustInclude !== null && !picked.includes(mustInclude)) return `The opening play must include the ${cardName(mustInclude)}.`;
  return null;
}

/** Play cards. Returns what happened, or false if the play was not allowed. */
export function tlPlay(g: TlGame, by: string, cards: unknown, now: number): false | 'play' | 'chop' | 'win' {
  if (g.phase !== 'play' || g.turn !== by) return false;
  const hand = g.hands[by];
  if (!hand || tlIllegal(hand, g.table?.cards ?? null, g.mustInclude, cards)) return false;
  const played = [...(cards as number[])].sort((a, b) => a - b);
  const combo = classify(played)!;
  const before = g.table ? classify(g.table.cards) : null;
  const chop = !!before && (before.kind !== combo.kind || before.n !== combo.n);
  const seat = g.players.findIndex((p) => p.id === by);
  const me = g.players[seat];
  g.hands[by] = hand.filter((c) => !played.includes(c));
  g.table = { by, name: me.name, cards: played };
  g.mustInclude = null;
  g.note = chop ? `${me.name} chopped with a ${COMBO_NAMES[combo.kind]}!` : null;
  if (!g.hands[by].length) {
    finish(g, me, `${me.name} is out of cards and wins the hand.`);
    return 'win';
  }
  advance(g, seat, now);
  if (!g.table) g.note = `Everyone else is out of the trick. ${me.name} leads.`;
  return chop ? 'chop' : 'play';
}

/** Pass: out of this trick until it ends. The player leading a trick cannot pass. */
export function tlPass(g: TlGame, by: string, now: number): boolean {
  if (g.phase !== 'play' || g.turn !== by || !g.table) return false;
  const seat = g.players.findIndex((p) => p.id === by);
  g.passed.push(by);
  g.note = `${g.players[seat].name} passed.`;
  advance(g, seat, now);
  if (!g.table) g.note = `Everyone passed. ${g.players.find((p) => p.id === g.turn)?.name ?? 'Someone'} leads.`;
  return true;
}

/** Someone left the table or the room. Returns true if anything changed. */
export function tlLeave(g: TlGame, id: string, now: number): boolean {
  const seat = g.players.findIndex((p) => p.id === id);
  if (seat < 0) return false;
  const gone = g.players[seat];
  g.players.splice(seat, 1);
  if (g.phase !== 'play') {
    // An empty table is a fresh session: the next hand opens with the lowest card again.
    if (!g.players.length) Object.assign(g, newTienlen());
    return true;
  }
  delete g.hands[id];
  g.passed = g.passed.filter((x) => x !== id);
  if (g.players.length < TL_MIN) {
    finish(g, g.players[0], `${gone.name} left. ${g.players[0].name} wins the hand.`);
    return true;
  }
  g.note = `${gone.name} left the table.`;
  // Nothing played yet: the opening card may have left with them, so work out the opener again.
  if (g.mustInclude !== null) openWithLowest(g, now);
  else if (g.turn === id) advance(g, (seat - 1 + g.players.length) % g.players.length, now);
  return true;
}

/** Time passing: an idle player passes, or plays their lowest card if they are leading. Returns true if anything changed. */
export function tlTick(g: TlGame, now: number): boolean {
  if (g.phase !== 'play' || !g.turn || now < g.until) return false;
  const by = g.turn;
  return g.table ? tlPass(g, by, now) : !!tlPlay(g, by, [g.hands[by][0]], now);
}

/** What one person sees. Only `hand` is private, and it is only ever the viewer's own. */
export interface TlView {
  phase: TlGame['phase'];
  players: { id: string; name: string; count: number; passed: boolean }[];
  turn: string | null;
  table: { by: string; name: string; cards: number[] } | null;
  mustInclude: number | null;
  /** Milliseconds left in the turn. */
  left: number;
  winner: TlPlayer | null;
  reveal: TlGame['reveal'];
  note: string | null;
  /** The viewer's own cards, or null if they are not in the hand. */
  hand: number[] | null;
}

export const tlView = (g: TlGame, viewer: string | null, now: number): TlView => ({
  phase: g.phase,
  players: g.players.map((p) => ({ id: p.id, name: p.name, count: g.hands[p.id]?.length ?? 0, passed: g.passed.includes(p.id) })),
  turn: g.turn,
  table: g.table,
  mustInclude: g.mustInclude,
  left: g.phase === 'play' ? Math.max(0, g.until - now) : 0,
  winner: g.winner,
  reveal: g.reveal,
  note: g.note,
  hand: (g.phase === 'play' && viewer !== null && g.hands[viewer]) || null,
});

/** What a browser may send. */
export type TlAction = { k: 'join' } | { k: 'leave' } | { k: 'deal' } | { k: 'play'; cards: number[] } | { k: 'pass' };
