// Tiến lên in two regional versions, Miền Nam (southern) and Miền Bắc (northern): shed your 13 cards
// by beating the play on the table. Rules only: no browser or server code in this file.

export const TL_MIN = 2;
export const TL_MAX = 4;
export const TL_HAND = 13;
/** How long a turn lasts before it is played for you. */
export const TURN_MS = 30_000;

export type Variant = 'nam' | 'bac';
export const VARIANT_NAMES: Record<Variant, string> = { nam: 'Miền Nam', bac: 'Miền Bắc' };
export const isVariant = (v: unknown): v is Variant => v === 'nam' || v === 'bac';

// A card is a number 0..51 equal to rank * 4 + suit, so a higher number is always a higher card.
export const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
export const SUITS = ['♠', '♣', '♦', '♥'];
const SUIT_WORDS = ['spade', 'club', 'diamond', 'heart'];
const TWO = 12;
export const rankOf = (c: number) => c >> 2;
export const suitOf = (c: number) => c & 3;
export const cardOf = (rank: number, suit: number) => rank * 4 + suit;
export const cardName = (c: number) => RANKS[rankOf(c)] + SUITS[suitOf(c)];
export const isRed = (c: number) => suitOf(c) >= 2;
const isTwo = (c: number) => rankOf(c) === TWO;

export type ComboKind = 'single' | 'pair' | 'triple' | 'quad' | 'straight' | 'pairs';
/** A legal set of cards: what it is, how many cards, and its highest card. `pairs` is a run of consecutive pairs. */
export interface Combo {
  kind: ComboKind;
  n: number;
  top: number;
}

/** What these cards are as a play in this version, or null if they are not a legal play. Treats its input as hostile. */
export function classify(cards: unknown, variant: Variant): Combo | null {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > TL_HAND) return null;
  const s = [...(cards as number[])].sort((a, b) => a - b);
  const n = s.length;
  for (let i = 0; i < n; i++) if (!Number.isInteger(s[i]) || s[i] < 0 || s[i] > 51 || (i > 0 && s[i] === s[i - 1])) return null;
  const top = s[n - 1];
  const ranks = s.map(rankOf);
  const north = variant === 'bac';
  if (n === 1) return { kind: 'single', n, top };
  if (ranks[0] === ranks[n - 1]) {
    // Northern pairs are two blacks or two reds.
    if (n === 2) return north && isRed(s[0]) !== isRed(s[1]) ? null : { kind: 'pair', n, top };
    return { kind: n === 3 ? 'triple' : 'quad', n, top };
  }
  // 2s never take part in a straight or a run of pairs.
  if (ranks[n - 1] === TWO) return null;
  if (n >= 3 && ranks.every((r, i) => r === ranks[0] + i)) {
    // Northern straights are all one suit.
    return north && !s.every((c) => suitOf(c) === suitOf(top)) ? null : { kind: 'straight', n, top };
  }
  // Runs of pairs exist only in the south.
  if (!north && n >= 6 && n % 2 === 0 && ranks.every((r, i) => r === ranks[0] + (i >> 1))) return { kind: 'pairs', n, top };
  return null;
}

/** Does play `a` beat `b`, the play on the table? */
export function beats(a: Combo, b: Combo, variant: Variant): boolean {
  const same = a.kind === b.kind && a.n === b.n;
  const twos = isTwo(b.top);
  if (variant === 'bac') {
    // The only chop: four of a kind over a single 2 or a pair of 2s.
    if (a.kind === 'quad' && twos && (b.kind === 'single' || b.kind === 'pair')) return true;
    if (!same) return false;
    if (a.kind === 'single') return isTwo(a.top) ? !twos || a.top > b.top : !twos && suitOf(a.top) === suitOf(b.top) && a.top > b.top;
    if (a.kind === 'pair') return isTwo(a.top) ? !twos || a.top > b.top : !twos && isRed(a.top) === isRed(b.top) && a.top > b.top;
    if (a.kind === 'straight') return suitOf(a.top) === suitOf(b.top) && a.top > b.top;
    return a.top > b.top;
  }
  // The ordinary way: same kind, same number of cards, higher top card (rank, then suit).
  if (same) return a.top > b.top;
  // Everything else is a chop. `run` is how many consecutive pairs `a` is.
  const run = a.kind === 'pairs' ? a.n / 2 : 0;
  const quad = a.kind === 'quad';
  if (b.kind === 'single' && twos) return quad || run >= 3;
  if (b.kind === 'pair' && twos) return quad || run >= 4;
  if (b.kind === 'triple' && twos) return run >= 5;
  if (b.kind === 'pairs' && b.n === 6) return quad || run >= 4;
  if (b.kind === 'pairs' && b.n === 8) return run >= 5;
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

/** Why these cards are not a play at all. Says so when it is the northern rules that rule them out. */
function whyNoCombo(cards: unknown, variant: Variant): string {
  const south = variant === 'bac' ? classify(cards, 'nam') : null;
  if (south?.kind === 'pair') return 'Miền Bắc: a pair must be the same colour.';
  if (south?.kind === 'straight') return 'Miền Bắc: a straight must be all one suit.';
  if (south?.kind === 'pairs') return 'Miền Bắc: there are no consecutive pairs.';
  return 'Not a legal set of cards.';
}

/** Why `a` does not beat `b`. */
function whyNoBeat(a: Combo, b: Combo, variant: Variant): string {
  if (variant === 'bac' && a.kind === b.kind && a.n === b.n) {
    const twos = isTwo(b.top);
    if (a.kind === 'single') return twos ? 'Miền Bắc: only a higher 2 or four of a kind beats a 2.' : `Miền Bắc: needs a higher ${SUIT_WORDS[suitOf(b.top)]}, or a 2.`;
    if (a.kind === 'pair') return twos ? 'Miền Bắc: only a higher pair of 2s or four of a kind beats a pair of 2s.' : `Miền Bắc: needs a higher ${isRed(b.top) ? 'red' : 'black'} pair, or a pair of 2s.`;
    if (a.kind === 'straight') return `Miền Bắc: needs a higher straight in ${SUIT_WORDS[suitOf(b.top)]}s.`;
  }
  return 'That does not beat the table.';
}

/** Why these cards cannot be played from `hand` right now, or null if they can. Shared with the browser to enable Play. */
export function tlIllegal(variant: Variant, hand: readonly number[], table: readonly number[] | null, mustInclude: number | null, cards: unknown): string | null {
  const combo = classify(cards, variant);
  if (!combo) return whyNoCombo(cards, variant);
  const picked = cards as number[];
  if (!picked.every((c) => hand.includes(c))) return 'You do not hold those cards.';
  if (table) {
    const t = classify(table, variant);
    if (!t) return 'That does not beat the table.';
    if (!beats(combo, t, variant)) return whyNoBeat(combo, t, variant);
  } else if (mustInclude !== null && !picked.includes(mustInclude)) return `The opening play must include the ${cardName(mustInclude)}.`;
  return null;
}

/** Northern rule: going out on 2s or on four of a kind puts you last. The reason if this (legal) play would do that, else null. */
export function tlThoi(variant: Variant, hand: readonly number[], cards: readonly number[]): string | null {
  if (variant !== 'bac' || cards.length !== hand.length) return null;
  if (cards.every(isTwo)) return 'finished on a 2';
  return classify(cards, variant)?.kind === 'quad' ? 'finished on four of a kind' : null;
}

/** Southern instant wins (tới trắng), checked on a freshly dealt hand. `first`: the first hand of a session. */
export function instantWin(hand: readonly number[], first: boolean): string | null {
  const count = Array<number>(13).fill(0);
  for (const c of hand) count[rankOf(c)]++;
  if (count[TWO] === 4) return 'four 2s';
  if (count.slice(0, TWO).every((n) => n >= 1)) return 'a dragon straight, 3 to ace';
  for (let r = 0; r + 5 <= TWO; r++) if (count.slice(r, r + 5).every((n) => n >= 2)) return 'five consecutive pairs';
  // Four of a kind counts as two of the six pairs.
  if (count.reduce((sum, n) => sum + (n >> 1), 0) >= 6) return 'six pairs';
  if (first && count[0] === 4) return 'four 3s';
  return null;
}

export interface TlPlayer {
  id: string;
  name: string;
}
/** One line of the results, best place first. */
export interface TlResult extends TlPlayer {
  /** Nhất, Nhì, Ba or Bét; empty for the also-rans of an instant win. */
  place: string;
  /** Cards they were left holding. */
  cards: number[];
  note: string | null;
}

export interface TlGame {
  variant: Variant;
  /** Who is at the table, in seat order (the order they joined). Play goes round in this order. */
  players: TlPlayer[];
  phase: 'lobby' | 'play' | 'ended';
  /** Each player's cards, sorted low to high. Secret. Empty once they have gone out. */
  hands: Record<string, number[]>;
  turn: string | null;
  /** The play to beat, or null when the player on turn leads a new trick. */
  table: { by: string; name: string; cards: number[] } | null;
  /** Who has passed in this trick: they are out until it ends. */
  passed: string[];
  /** Southern opening: the first play of a session must include this card (the lowest dealt: 3♠ with four players). */
  mustInclude: number | null;
  /** True until the first play of a session's first hand, while "lowest card leads" still applies. */
  opening: boolean;
  /** When the turn times out (server clock). */
  until: number;
  /** Winner of the last hand, who leads the next one. */
  lastWinner: string | null;
  winner: TlPlayer | null;
  /** Who has run out of cards this hand, in order. `thoi`: the northern penalty that sends them to last place. */
  out: (TlPlayer & { thoi: string | null })[];
  results: TlResult[] | null;
  /** One line about the last thing that happened, for the panel. */
  note: string | null;
}

export const newTienlen = (): TlGame => ({
  variant: 'nam',
  players: [],
  phase: 'lobby',
  hands: {},
  turn: null,
  table: null,
  passed: [],
  mustInclude: null,
  opening: false,
  until: 0,
  lastWinner: null,
  winner: null,
  out: [],
  results: null,
  note: null,
});

const seated = (g: TlGame, id: string) => g.players.some((p) => p.id === id);
/** Still holding cards in this hand. */
const active = (g: TlGame, id: string) => (g.hands[id]?.length ?? 0) > 0;
const nameOf = (g: TlGame, id: string | null) => g.players.find((p) => p.id === id)?.name ?? 'Someone';

export function tlJoin(g: TlGame, p: TlPlayer): boolean {
  // Nobody sits down in the middle of a hand: they watch until the next deal.
  if (g.phase === 'play' || g.players.length >= TL_MAX || seated(g, p.id)) return false;
  g.players.push({ id: p.id, name: p.name });
  return true;
}

/** Choose the regional version. Only someone at the table, and only between hands. */
export function tlVariant(g: TlGame, by: string, v: unknown): boolean {
  if (g.phase === 'play' || !seated(g, by) || !isVariant(v) || v === g.variant) return false;
  g.variant = v;
  return true;
}

function lead(g: TlGame, id: string, now: number) {
  g.table = null;
  g.passed = [];
  g.turn = id;
  g.until = now + TURN_MS;
}

/** The first player after seat `from` who still holds cards. */
function nextActive(g: TlGame, from: number): string {
  const n = g.players.length;
  for (let i = 1; i <= n; i++) if (active(g, g.players[(from + i) % n].id)) return g.players[(from + i) % n].id;
  return g.players[0].id;
}

/** Pass the turn on from seat `from`. Coming back round to whoever owns the table ends the trick. */
function advance(g: TlGame, from: number, now: number) {
  const n = g.players.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    const p = g.players[seat];
    // The owner leads again; if they have gone out, the next player still in inherits the lead (hưởng sái).
    if (g.table && p.id === g.table.by) return lead(g, active(g, p.id) ? p.id : nextActive(g, seat), now);
    if (active(g, p.id) && !g.passed.includes(p.id)) {
      g.turn = p.id;
      g.until = now + TURN_MS;
      return;
    }
  }
  // Everyone passed and the owner of the table has left it: the next player still in leads.
  lead(g, nextActive(g, from), now);
}

const PLACES = ['Nhất', 'Nhì', 'Ba', 'Bét'];

function close(g: TlGame, results: TlResult[], note: string) {
  g.results = results;
  g.phase = 'ended';
  g.winner = results.length ? { id: results[0].id, name: results[0].name } : null;
  g.lastWinner = g.winner?.id ?? null;
  g.hands = {};
  g.out = [];
  g.turn = null;
  g.passed = [];
  g.mustInclude = null;
  g.opening = false;
  g.until = 0;
  g.note = note;
}

/** The hand is over: rank those who went out in order, then whoever still holds cards, then anyone sent last (thối). */
function finish(g: TlGame) {
  const order: TlResult[] = [];
  for (const o of g.out) if (!o.thoi) order.push({ id: o.id, name: o.name, place: '', cards: [], note: null });
  for (const p of g.players) {
    if (!active(g, p.id)) continue;
    const twos = g.hands[p.id].filter(isTwo).length;
    order.push({ id: p.id, name: p.name, place: '', cards: g.hands[p.id], note: twos ? `Thối heo: left holding ${twos === 1 ? 'a 2' : `${twos} 2s`}.` : null });
  }
  for (const o of g.out) if (o.thoi) order.push({ id: o.id, name: o.name, place: '', cards: [], note: `Thối: ${o.thoi}, so placed last.` });
  order.forEach((r, i) => (r.place = i === 0 ? PLACES[0] : i === order.length - 1 ? PLACES[3] : PLACES[i]));
  close(g, order, order.length ? `${order[0].name} wins the hand (nhất).` : 'The hand is over.');
}

/** Whoever holds the lowest card dealt (the 3♠ if it is out) leads. In the south their first play must include it. */
function openWithLowest(g: TlGame, now: number) {
  let low = 52;
  let who = g.players[0].id;
  for (const p of g.players) {
    const c = g.hands[p.id]?.[0] ?? 52;
    if (c < low) {
      low = c;
      who = p.id;
    }
  }
  lead(g, who, now);
  g.opening = true;
  g.mustInclude = g.variant === 'nam' ? low : null;
}

/** Start a hand from `g.hands` (already dealt). Split from tlDeal so tests can set up exact hands. */
export function tlBegin(g: TlGame, now: number) {
  for (const p of g.players) g.hands[p.id].sort((a, b) => a - b);
  g.phase = 'play';
  g.winner = null;
  g.results = null;
  g.out = [];
  g.note = null;
  g.mustInclude = null;
  g.opening = false;
  // First hand of a session (or the winner has gone): lowest card leads. Later hands: the winner leads anything.
  if (g.lastWinner && seated(g, g.lastWinner)) lead(g, g.lastWinner, now);
  else openWithLowest(g, now);
  if (g.variant !== 'nam') return;
  // Tới trắng: a hand that wins outright, the earliest in turn order if there are two.
  const n = g.players.length;
  const from = g.players.findIndex((p) => p.id === g.turn);
  for (let i = 0; i < n; i++) {
    const w = g.players[(from + i) % n];
    const why = instantWin(g.hands[w.id], g.opening);
    if (!why) continue;
    const row = (p: TlPlayer, first: boolean): TlResult => ({ id: p.id, name: p.name, place: first ? PLACES[0] : '', cards: g.hands[p.id], note: first ? `Tới trắng: ${why}.` : null });
    g.table = null;
    close(g, [row(w, true), ...g.players.filter((p) => p.id !== w.id).map((p) => row(p, false))], `${w.name} wins at once (tới trắng): ${why}.`);
    return;
  }
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

/**
 * Play cards. Returns what happened, or false if the play was not allowed:
 * 'out' the player ran out of cards and the hand goes on, 'end' the hand is over.
 */
export function tlPlay(g: TlGame, by: string, cards: unknown, now: number): false | 'play' | 'chop' | 'out' | 'end' {
  if (g.phase !== 'play' || g.turn !== by) return false;
  const hand = g.hands[by];
  if (!hand || tlIllegal(g.variant, hand, g.table?.cards ?? null, g.mustInclude, cards)) return false;
  const played = [...(cards as number[])].sort((a, b) => a - b);
  const combo = classify(played, g.variant)!;
  const before = g.table ? classify(g.table.cards, g.variant) : null;
  const chop = !!before && (before.kind !== combo.kind || before.n !== combo.n);
  const thoi = tlThoi(g.variant, hand, played);
  const seat = g.players.findIndex((p) => p.id === by);
  const me = g.players[seat];
  g.hands[by] = hand.filter((c) => !played.includes(c));
  g.table = { by, name: me.name, cards: played };
  g.mustInclude = null;
  g.opening = false;
  g.note = chop ? `${me.name} chopped with a ${COMBO_NAMES[combo.kind]}!` : null;
  const gone = !g.hands[by].length;
  if (gone) {
    g.out.push({ id: me.id, name: me.name, thoi });
    if (g.players.filter((p) => active(g, p.id)).length <= 1) {
      finish(g);
      return 'end';
    }
    g.note = thoi ? `${me.name} ${thoi}: thối, placed last.` : `${me.name} is out of cards.`;
  }
  advance(g, seat, now);
  if (!g.table) g.note = gone ? `${g.note} Nobody beat the last play, so ${nameOf(g, g.turn)} leads (hưởng sái).` : `Everyone else is out of the trick. ${me.name} leads.`;
  return gone ? 'out' : chop ? 'chop' : 'play';
}

/** Pass: out of this trick until it ends. The player leading a trick cannot pass. */
export function tlPass(g: TlGame, by: string, now: number): boolean {
  if (g.phase !== 'play' || g.turn !== by || !g.table) return false;
  const seat = g.players.findIndex((p) => p.id === by);
  const owner = g.table.by;
  g.passed.push(by);
  g.note = `${g.players[seat].name} passed.`;
  advance(g, seat, now);
  if (!g.table) g.note = `Everyone passed. ${nameOf(g, g.turn)} leads${g.turn === owner ? '' : ' (hưởng sái)'}.`;
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
  // Someone who had already gone out keeps their place; someone who still held cards is simply dropped.
  delete g.hands[id];
  g.passed = g.passed.filter((x) => x !== id);
  if (g.players.filter((p) => active(g, p.id)).length <= 1) {
    finish(g);
    g.note = `${gone.name} left. ${g.note}`;
    return true;
  }
  g.note = `${gone.name} left the table.`;
  // Nothing played yet: the lowest card may have left with them, so work out the opener again.
  if (g.opening) openWithLowest(g, now);
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
  variant: Variant;
  phase: TlGame['phase'];
  /** `out`: has run out of cards this hand. */
  players: { id: string; name: string; count: number; passed: boolean; out: boolean }[];
  turn: string | null;
  table: { by: string; name: string; cards: number[] } | null;
  mustInclude: number | null;
  /** Milliseconds left in the turn. */
  left: number;
  winner: TlPlayer | null;
  /** Finishing order and leftover cards, once the hand is over. */
  results: TlResult[] | null;
  note: string | null;
  /** The viewer's own cards, or null if they are not in the hand. */
  hand: number[] | null;
}

export const tlView = (g: TlGame, viewer: string | null, now: number): TlView => ({
  variant: g.variant,
  phase: g.phase,
  players: g.players.map((p) => ({ id: p.id, name: p.name, count: g.hands[p.id]?.length ?? 0, passed: g.passed.includes(p.id), out: g.out.some((o) => o.id === p.id) })),
  turn: g.turn,
  table: g.table,
  mustInclude: g.mustInclude,
  left: g.phase === 'play' ? Math.max(0, g.until - now) : 0,
  winner: g.winner,
  results: g.results,
  note: g.note,
  hand: (g.phase === 'play' && viewer !== null && g.hands[viewer]) || null,
});

/** What a browser may send. */
export type TlAction = { k: 'join' } | { k: 'leave' } | { k: 'deal' } | { k: 'variant'; v: Variant } | { k: 'play'; cards: number[] } | { k: 'pass' };
