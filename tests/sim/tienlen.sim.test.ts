// Tiến lên, both regional versions, played thousands of times by a seeded random crowd that also misbehaves.
// Three things are driven with the same actions and the same random numbers: the rules (a "shadow" state the
// test can see into), the real server factory behind a recording GameIO, and the test's own model of the table
// with its own reading of the rules (what is a legal set, what beats what, whose turn is next, who finished where).
// After every step the rules are checked against the model and the server's messages against both.
//
//   SIM_RUNS=20000 npx vitest run tests/sim/tienlen.sim.test.ts --silent=false     more sessions, with the counts
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/tienlen.sim.test.ts     replay one failing seed
import { afterAll, expect, test, vi } from 'vitest';
import type { PlayerInfo } from '../../shared/protocol';
import type { GameIO } from '../../worker/src/minigames/api';
import { create } from '../../worker/src/minigames/tienlen';
import { TL_HAND, TL_MAX, TL_MIN, TURN_MS, newTienlen, tlDeal, tlJoin, tlLeave, tlPass, tlPlay, tlTick, tlVariant, tlView, type Variant } from '../../shared/minigames/tienlen';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 700;
const SEED0 = Number(ENV.SIM_SEED) || 1;

// ---------------------------------------------------------------------------------------------------------
// Harness. The same in every tests/sim file (kept inline: each game owns only its own files).
// ---------------------------------------------------------------------------------------------------------
type Rnd = () => number;
/** mulberry32: small, fast, and the same everywhere. */
const rng = (seed: number): Rnd => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const int = (r: Rnd, n: number) => Math.floor(r() * n);
const pick = <T>(r: Rnd, xs: readonly T[]): T => xs[int(r, xs.length)];
const chance = (r: Rnd, p: number) => r() < p;
/** Throws with a message; much cheaper than `expect` in a loop that runs millions of times. */
function must(ok: unknown, msg: string | (() => string)): asserts ok {
  if (!ok) throw new Error(typeof msg === 'string' ? msg : msg());
}
const json = (v: unknown) => JSON.stringify(v);

/** Values no honest browser sends. Made fresh each time, so one game changing one cannot affect the next. */
const GARBAGE: (() => unknown)[] = [
  () => undefined, () => null, () => NaN, () => Infinity, () => -Infinity, () => -1, () => -0, () => 0.5, () => 1e308, () => 2 ** 53, () => -(2 ** 31), () => 3.0000001,
  () => '', () => '0', () => '1', () => ' ', () => 'x'.repeat(200_000), () => '__proto__', () => 'constructor', () => 'toString',
  () => true, () => false, () => [], () => [1], () => [[]], () => [NaN, 'a', null], () => new Array(5), () => ({}), () => ({ length: 2, 0: 1, 1: 2 }),
  () => Object.create(null), () => Object.create({ k: 'join', kind: 'truth', n: 1 }), () => ({ toString: () => 'truth', valueOf: () => 1 }),
  () => JSON.parse('{"__proto__":{"k":"join"},"constructor":{"prototype":1},"length":3}'), () => new Date(0), () => new Map([[1, 2]]),
];
const garbage = (r: Rnd) => pick(r, GARBAGE)();

/**
 * Fails on anything a browser could not sensibly show: NaN and infinities, `undefined` in a list, text built
 * from them, and negative numbers anywhere except under the keys named in `signed`.
 */
function scan(v: unknown, signed: readonly string[], path: string, key = ''): void {
  if (typeof v === 'number') {
    must(Number.isFinite(v), `${path} is ${v}`);
    must(v >= 0 || signed.includes(key), `${path} is negative: ${v}`);
  } else if (typeof v === 'string') must(!/undefined|NaN|Infinity|\[object /.test(v), `${path} has broken text: ${v.slice(0, 80)}`);
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) {
    must(v[i] !== undefined, `${path}[${i}] is undefined`);
    scan(v[i], signed, `${path}[${i}]`, key);
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, signed, `${path}.${k}`, k);
  else must(v === null || v === undefined || typeof v === 'boolean', `${path} is a ${typeof v}`);
}

interface Sent {
  /** Who it went to; null for a broadcast. */
  to: string | null;
  /** The message as a browser would get it: through JSON. */
  v: any;
}
const NAMES = ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Giang', 'Ann', 'Bao']; // repeats on purpose: names are not unique

/** A fake room: a changing list of people, and a GameIO that records and checks everything the game sends. */
function makeRoom(signed: readonly string[] = []) {
  const people: PlayerInfo[] = [];
  const out: Sent[] = [];
  const notices: string[] = [];
  let made = 0;
  const here = (id: string) => people.some((p) => p.id === id);
  const record = (to: string | null, v: unknown) => {
    scan(v, signed, to === null ? 'broadcast' : `send(${to})`);
    out.push({ to, v: JSON.parse(json(v)) });
  };
  const never = (what: string) => () => {
    throw new Error(`the game called io.${what}, which it has no reason to`);
  };
  const io: GameIO = {
    players: () => people.map((p) => ({ ...p })),
    send: (id, v) => record(id, v),
    broadcast: (v) => record(null, v),
    notice: (text) => {
      scan(text, [], 'notice');
      must(typeof text === 'string' && text.trim().length > 0, 'empty notice');
      notices.push(text);
    },
    emote: (id, k) => must(here(id) && typeof k === 'string' && k.length > 0, `emote for ${id}, who is not in the room`),
    put: never('put'),
    nudge: never('nudge'),
    resetBall: never('resetBall'),
    setScore: never('setScore'),
  };
  /** Someone new walks in. Ids are never reused, as on the real server. */
  const enter = (): PlayerInfo => {
    made++;
    const p: PlayerInfo = { id: `p${made}`, name: NAMES[made % NAMES.length], color: '#fff', look: 'a', x: made, z: -made, ry: 0, seat: null };
    people.push(p);
    return p;
  };
  const exit = (id: string) => people.splice(people.findIndex((p) => p.id === id), 1);
  return { people, out, notices, io, enter, exit, here };
}

/** The server's Math.random, pointed at a seeded stream for each session. */
let serverRandom: Rnd = () => 0;
const spy = vi.spyOn(Math, 'random').mockImplementation(() => serverRandom());
afterAll(() => spy.mockRestore());

/** Run `session` for RUNS seeds; a failure names the seed that replays it. */
function simulate(name: string, session: (seed: number, trail: string[]) => void) {
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED0 + i;
    const trail: string[] = [];
    // The spy records every call; without this a long run fills the memory.
    spy.mockClear();
    try {
      session(seed, trail);
    } catch (e) {
      const err = e as Error;
      err.message = `[${name} sim] seed=${seed} step=${trail.length}: ${err.message}\n  replay: SIM_SEED=${seed} SIM_RUNS=1 npx vitest run tests/sim/${name}.sim.test.ts\n  last steps:\n    ${trail.slice(-15).join('\n    ')}`;
      throw err;
    }
  }
}
// ---------------------------------------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const stats = {
  sessions: 0, steps: 0, deals: 0, dealsNam: 0, dealsBac: 0, stacked: 0, instant: 0, endedByPlay: 0, endedByLeave: 0, plays: 0, passes: 0,
  chops: 0, thoi: 0, timeouts: 0, refused: 0, trickResets: 0, leavesMidHand: 0, sai: 0, drains: 0, late: 0,
};

// ---- An independent reading of the rules: nothing below calls classify, beats, tlIllegal, tlThoi or instantWin. ----
const rk = (c: number) => Math.floor(c / 4);
const st = (c: number) => c % 4;
const red = (c: number) => st(c) >= 2;
const DEUCE = 12;
interface Shape {
  kind: 'single' | 'pair' | 'triple' | 'quad' | 'straight' | 'pairs';
  len: number;
  top: number;
}
/** Is this something a browser could honestly send as a set of cards? */
const isCards = (x: unknown): x is number[] =>
  Array.isArray(x) && x.length >= 1 && x.length <= TL_HAND && x.every((c) => typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 51) && new Set(x).size === x.length;

function shape(cards: readonly number[], v: Variant): Shape | null {
  const s = [...cards].sort((a, b) => a - b);
  const len = s.length;
  const top = s[len - 1];
  const groups = new Map<number, number>();
  for (const c of s) groups.set(rk(c), (groups.get(rk(c)) ?? 0) + 1);
  const ranks = [...groups.keys()];
  if (len === 1) return { kind: 'single', len, top };
  if (ranks.length === 1) {
    if (len === 2) return v === 'bac' && red(s[0]) !== red(s[1]) ? null : { kind: 'pair', len, top };
    return { kind: len === 3 ? 'triple' : 'quad', len, top };
  }
  if (ranks.includes(DEUCE)) return null;
  if (!ranks.every((x, i) => i === 0 || x === ranks[i - 1] + 1)) return null;
  const sizes = [...groups.values()];
  if (sizes.every((k) => k === 1) && len >= 3) return v === 'bac' && new Set(s.map(st)).size !== 1 ? null : { kind: 'straight', len, top };
  if (sizes.every((k) => k === 2) && ranks.length >= 3 && v === 'nam') return { kind: 'pairs', len, top };
  return null;
}

function wins(a: Shape, b: Shape, v: Variant): boolean {
  const deuce = (x: Shape) => rk(x.top) === DEUCE;
  const alike = a.kind === b.kind && a.len === b.len;
  if (v === 'bac') {
    if (a.kind === 'quad') return b.kind === 'quad' ? a.top > b.top : deuce(b) && (b.kind === 'single' || b.kind === 'pair');
    if (!alike) return false;
    if (a.kind === 'triple') return rk(a.top) > rk(b.top);
    if (a.kind === 'straight') return st(a.top) === st(b.top) && rk(a.top) > rk(b.top);
    if (a.kind !== 'single' && a.kind !== 'pair') return false;
    if (deuce(a)) return !deuce(b) || a.top > b.top;
    if (deuce(b) || rk(a.top) <= rk(b.top)) return false;
    return a.kind === 'single' ? st(a.top) === st(b.top) : red(a.top) === red(b.top);
  }
  if (alike) return a.top > b.top;
  const run = a.kind === 'pairs' ? a.len / 2 : 0;
  const quad = a.kind === 'quad';
  if (deuce(b) && b.kind === 'single') return quad || run >= 3;
  if (deuce(b) && b.kind === 'pair') return quad || run >= 4;
  if (deuce(b) && b.kind === 'triple') return run >= 5;
  if (b.kind === 'pairs' && b.len === 6) return quad || run >= 4;
  if (b.kind === 'pairs' && b.len === 8) return run >= 5;
  if (b.kind === 'quad') return run >= 4;
  return false;
}

/** A southern hand that wins the moment it is dealt. `first`: the first hand of a session. */
function winsAtOnce(hand: readonly number[], first: boolean): boolean {
  const n = Array<number>(13).fill(0);
  for (const c of hand) n[rk(c)]++;
  if (n[DEUCE] === 4) return true;
  if (n.slice(0, DEUCE).every((k) => k > 0)) return true;
  let streak = 0;
  for (let x = 0; x < DEUCE; x++) {
    streak = n[x] >= 2 ? streak + 1 : 0;
    if (streak >= 5) return true;
  }
  if (n.reduce((sum, k) => sum + Math.floor(k / 2), 0) >= 6) return true;
  return first && n[0] === 4;
}

/** Every k-card subset of xs. */
function subsets(xs: number[], k: number): number[][] {
  if (k === 0) return [[]];
  if (xs.length < k) return [];
  return [...subsets(xs.slice(1), k - 1).map((s) => [xs[0], ...s]), ...subsets(xs.slice(1), k)];
}
/** Plays worth trying from a hand: all singles and sets, and a spread of straights and pair runs. */
function candidates(hand: readonly number[], v: Variant, r: Rnd): number[][] {
  const out: number[][] = hand.map((c) => [c]);
  const by: number[][] = Array.from({ length: 13 }, () => []);
  for (const c of hand) by[rk(c)].push(c);
  for (const cs of by) for (const k of [2, 3, 4]) out.push(...subsets(cs, k));
  for (let a = 0; a < DEUCE; a++) {
    for (let len = 3; a + len <= DEUCE; len++) {
      const span = by.slice(a, a + len);
      if (span.some((cs) => !cs.length)) break;
      if (v === 'bac') {
        for (let suit = 0; suit < 4; suit++) if (span.every((cs) => cs.some((c) => st(c) === suit))) out.push(span.map((cs) => cs.find((c) => st(c) === suit)!));
      } else {
        out.push(span.map((cs) => pick(r, cs)));
        out.push(span.map((cs) => cs[cs.length - 1]));
      }
      if (v === 'nam' && span.every((cs) => cs.length >= 2)) out.push(span.flatMap((cs) => pick(r, subsets(cs, 2))));
    }
  }
  return out;
}

/** The random numbers that make tlDeal's shuffle come out as exactly `target`. */
function stack(target: number[]): number[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  const vals: number[] = [];
  for (let i = 51; i > 0; i--) {
    const j = deck.indexOf(target[i]);
    vals.push((j + 0.5) / (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return vals;
}
/** A deck arranged so that interesting hands turn up far more often than chance would deal them. */
function riggedDeck(r: Rnd): number[] {
  const all = Array.from({ length: 52 }, (_, i) => i);
  const shuffle = <T>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = int(r, i + 1);
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  const kind = pick(r, ['twos', 'dragon', 'fivepairs', 'sixpairs', 'threes', 'suits', 'ranks', 'ranks', 'suits']);
  const seat = int(r, 4);
  if (kind === 'suits') return [0, 1, 2, 3].flatMap((i) => all.filter((c) => st(c) === (i + seat) % 4));
  if (kind === 'ranks') {
    const turn = seat * 13;
    return [...all.slice(turn), ...all.slice(0, turn)];
  }
  let special: number[] = [];
  if (kind === 'twos') special = [48, 49, 50, 51];
  else if (kind === 'threes') special = [0, 1, 2, 3];
  else if (kind === 'dragon') special = Array.from({ length: 12 }, (_, x) => x * 4 + int(r, 4));
  else if (kind === 'fivepairs') {
    const a = int(r, 8);
    special = [0, 1, 2, 3, 4].flatMap((i) => pick(r, subsets([0, 1, 2, 3], 2)).map((s) => (a + i) * 4 + s));
  } else special = shuffle(Array.from({ length: 13 }, (_, x) => x)).slice(0, 6).flatMap((x) => pick(r, subsets([0, 1, 2, 3], 2)).map((s) => x * 4 + s));
  const rest = shuffle(all.filter((c) => !special.includes(c)));
  const hand = [...special, ...rest.splice(0, 13 - special.length)];
  const hands = [rest.slice(0, 13), rest.slice(13, 26), rest.slice(26, 39)];
  hands.splice(seat, 0, hand);
  return [...hands.flat(), ...rest.slice(39)];
}

const VIEW_KEYS = ['hand', 'left', 'mustInclude', 'note', 'phase', 'players', 'results', 'table', 'turn', 'variant', 'winner'];
const PLACES = ['Nhất', 'Nhì', 'Ba', 'Bét'];

function session(seed: number, trail: string[]) {
  const r = rng(seed);
  // The server and the shadow draw from two copies of one stream (or one stacked deck), so they must stay in step.
  const a = rng(seed ^ 0x5eed);
  const b = rng(seed ^ 0x5eed);
  let serverDraws = 0;
  let shadowDraws = 0;
  let serverStack: number[] = [];
  let shadowStack: number[] = [];
  serverRandom = () => (serverDraws++, serverStack.length ? serverStack.shift()! : a());
  const rnd = () => (shadowDraws++, shadowStack.length ? shadowStack.shift()! : b());

  const room = makeRoom();
  const server = create(room.io);
  const g = newTienlen();
  let now = T0 + int(r, 1e9);

  // ---- The test's own model of the table, kept up to date by its own reading of the rules. ----
  const m = {
    phase: 'lobby' as 'lobby' | 'play' | 'ended',
    variant: 'nam' as Variant,
    seats: [] as { id: string; name: string }[],
    hands: new Map<string, number[]>(),
    turn: null as string | null,
    table: null as { by: string; cards: number[] } | null,
    passed: new Set<string>(),
    /** No card has been played yet in a hand that the lowest card opens. */
    opening: false,
    lastWinner: null as string | null,
    outs: [] as { id: string; thoi: boolean }[],
    played: new Set<number>(),
    leftWith: new Set<number>(),
    undealt: new Set<number>(),
    deadline: 0,
    /** Once a hand is over: who should be listed, best first, what they were left holding, and how it ended. */
    order: null as string[] | null,
    leftover: new Map<string, number[]>(),
    instant: false,
  };
  let notices = 0;
  /** A deadline has passed but the server has not ticked yet: it only ticks every 100 ms, so actions can land in the gap. */
  let owed = false;
  const seated = (id: string) => m.seats.some((p) => p.id === id);
  const has = (id: string) => (m.hands.get(id)?.length ?? 0) > 0;
  const lowest = () => {
    let best = { id: m.seats[0]?.id ?? '', card: 52 };
    for (const p of m.seats) {
      const c = m.hands.get(p.id)?.[0] ?? 52;
      if (c < best.card) best = { id: p.id, card: c };
    }
    return best;
  };
  const nextWithCards = (idx: number) => {
    for (let i = 1; i <= m.seats.length; i++) if (has(m.seats[(idx + i) % m.seats.length].id)) return m.seats[(idx + i) % m.seats.length].id;
    throw new Error('nobody holds cards');
  };
  const lead = (id: string) => {
    m.table = null;
    m.passed.clear();
    m.turn = id;
    m.deadline = now + TURN_MS;
  };
  /** Who is next after seat `idx`: round the table, skipping the passed and the finished, until the trick comes home. */
  const walk = (idx: number) => {
    const n = m.seats.length;
    for (let i = 1; i <= n; i++) {
      const q = m.seats[(idx + i) % n];
      if (m.table && q.id === m.table.by) {
        stats.trickResets++;
        if (!has(q.id)) stats.sai++;
        return lead(has(q.id) ? q.id : nextWithCards((idx + i) % n));
      }
      if (has(q.id) && !m.passed.has(q.id)) {
        m.turn = q.id;
        m.deadline = now + TURN_MS;
        return;
      }
    }
    stats.trickResets++;
    lead(nextWithCards(idx));
  };
  const finishHand = (how: 'play' | 'leave') => {
    const holders = m.seats.filter((p) => has(p.id));
    m.order = [...m.outs.filter((o) => !o.thoi).map((o) => o.id), ...holders.map((p) => p.id), ...m.outs.filter((o) => o.thoi).map((o) => o.id)];
    must(m.order.length > 0, 'a hand ended with nobody to rank');
    m.leftover = new Map(holders.map((p) => [p.id, m.hands.get(p.id)!]));
    m.instant = false;
    m.phase = 'ended';
    m.lastWinner = m.order[0];
    m.turn = null;
    m.passed.clear();
    m.hands = new Map();
    m.opening = false;
    notices++;
    stats[how === 'play' ? 'endedByPlay' : 'endedByLeave']++;
  };
  const canPlay = (by: string, cards: unknown): boolean => {
    if (m.phase !== 'play' || m.turn !== by || !isCards(cards)) return false;
    const hand = m.hands.get(by)!;
    if (!cards.every((c) => hand.includes(c))) return false;
    const sh = shape(cards, m.variant);
    if (!sh) return false;
    if (m.table) return wins(sh, shape(m.table.cards, m.variant)!, m.variant);
    return !(m.opening && m.variant === 'nam') || cards.includes(lowest().card);
  };
  /** Apply a play the oracle allowed. Returns what tlPlay should report. */
  const modelPlay = (by: string, cards: number[]): string => {
    const sorted = [...cards].sort((x, y) => x - y);
    const sh = shape(sorted, m.variant)!;
    const was = m.table && shape(m.table.cards, m.variant)!;
    const chop = !!was && (was.kind !== sh.kind || was.len !== sh.len);
    const rest = m.hands.get(by)!.filter((c) => !sorted.includes(c));
    m.hands.set(by, rest);
    for (const c of sorted) {
      must(!m.played.has(c), `card ${c} was played twice`);
      m.played.add(c);
    }
    m.table = { by, cards: sorted };
    m.opening = false;
    stats.plays++;
    if (chop) stats.chops++;
    if (!rest.length) {
      // Northern rule: your last play may not be 2s or four of a kind, or you are placed last.
      const thoi = m.variant === 'bac' && (sorted.every((c) => rk(c) === DEUCE) || sh.kind === 'quad');
      if (thoi) stats.thoi++;
      m.outs.push({ id: by, thoi });
      if (m.seats.filter((p) => has(p.id)).length <= 1) {
        finishHand('play');
        return 'end';
      }
    }
    walk(m.seats.findIndex((p) => p.id === by));
    return !rest.length ? 'out' : chop ? 'chop' : 'play';
  };
  const modelPass = (by: string) => {
    m.passed.add(by);
    stats.passes++;
    walk(m.seats.findIndex((p) => p.id === by));
  };
  const modelLeave = (id: string) => {
    const idx = m.seats.findIndex((p) => p.id === id);
    m.seats.splice(idx, 1);
    if (m.phase !== 'play') {
      // An empty table forgets everything, the chosen version included.
      if (!m.seats.length) Object.assign(m, { phase: 'lobby', variant: 'nam', table: null, lastWinner: null, order: null, turn: null, opening: false });
      return;
    }
    stats.leavesMidHand++;
    for (const c of m.hands.get(id) ?? []) m.leftWith.add(c);
    m.hands.delete(id);
    m.passed.delete(id);
    if (m.seats.filter((p) => has(p.id)).length <= 1) return finishHand('leave');
    if (m.opening) lead(lowest().id);
    else if (m.turn === id) walk((idx - 1 + m.seats.length) % m.seats.length);
  };
  /** The rules have just dealt: read the hands they dealt, check them, and work out for myself how the hand opens. */
  const modelDeal = () => {
    const dealt = new Map<string, number[]>();
    if (g.phase === 'play') for (const p of m.seats) dealt.set(p.id, [...(g.hands[p.id] ?? [])]);
    else for (const row of g.results ?? []) dealt.set(row.id, [...row.cards]);
    const all: number[] = [];
    for (const p of m.seats) {
      const h = dealt.get(p.id);
      must(h && h.length === TL_HAND && isCards(h) && h.every((c, i) => i === 0 || c > h[i - 1]), `${p.id} was dealt ${json(h)}`);
      all.push(...h);
    }
    must(new Set(all).size === m.seats.length * TL_HAND, 'the same card was dealt twice');
    m.hands = dealt;
    m.played = new Set();
    m.leftWith = new Set();
    m.undealt = new Set(Array.from({ length: 52 }, (_, i) => i).filter((c) => !all.includes(c)));
    m.outs = [];
    m.order = null;
    const winner = m.lastWinner && seated(m.lastWinner) ? m.lastWinner : null;
    m.opening = !winner;
    const leader = winner ?? lowest().id;
    stats.deals++;
    stats[m.variant === 'nam' ? 'dealsNam' : 'dealsBac']++;
    if (m.variant === 'nam') {
      const from = m.seats.findIndex((p) => p.id === leader);
      for (let i = 0; i < m.seats.length; i++) {
        const w = m.seats[(from + i) % m.seats.length];
        if (!winsAtOnce(m.hands.get(w.id)!, m.opening)) continue;
        m.order = [w.id, ...m.seats.filter((p) => p.id !== w.id).map((p) => p.id)];
        m.leftover = m.hands;
        m.hands = new Map();
        Object.assign(m, { instant: true, phase: 'ended', lastWinner: w.id, turn: null, table: null, opening: false });
        m.passed.clear();
        notices++;
        stats.instant++;
        return;
      }
    }
    m.phase = 'play';
    lead(leader);
  };

  /** The rules' state must be exactly what my model says, and must hold together on its own terms. */
  const compare = () => {
    must(g.phase === m.phase, `phase is ${g.phase}, expected ${m.phase}`);
    must(g.variant === m.variant, `variant is ${g.variant}, expected ${m.variant}`);
    must(json(g.players.map((p) => p.id)) === json(m.seats.map((p) => p.id)), `seats are ${json(g.players)}`);
    must(g.players.length <= TL_MAX, 'too many at the table');
    for (const p of g.players) must(room.here(p.id), `${p.id} is at the table but not in the room`);
    must(g.lastWinner === m.lastWinner, `lastWinner is ${g.lastWinner}, expected ${m.lastWinner}`);
    if (m.phase === 'play') {
      must(g.turn === m.turn, `turn is ${g.turn}, expected ${m.turn}`);
      must(m.turn !== null && seated(m.turn) && has(m.turn) && !m.passed.has(m.turn), `${m.turn} cannot act but it is their turn`);
      must(json(g.table && { by: g.table.by, cards: g.table.cards }) === json(m.table), `table is ${json(g.table)}, expected ${json(m.table)}`);
      must(json([...g.passed].sort()) === json([...m.passed].sort()), `passed is ${json(g.passed)}, expected ${json([...m.passed])}`);
      must(json(Object.keys(g.hands).sort()) === json(m.seats.map((p) => p.id).sort()), `hands are held by ${json(Object.keys(g.hands))}`);
      for (const p of m.seats) must(json(g.hands[p.id]) === json(m.hands.get(p.id)), `${p.id} holds ${json(g.hands[p.id])}, expected ${json(m.hands.get(p.id))}`);
      must(g.opening === m.opening, `opening is ${g.opening}`);
      must(g.mustInclude === (m.opening && m.variant === 'nam' ? lowest().card : null), `mustInclude is ${g.mustInclude}`);
      must(g.results === null && g.winner === null, 'results are showing during a hand');
      must(json(g.out.map((o) => [o.id, !!o.thoi])) === json(m.outs.map((o) => [o.id, o.thoi])), `out is ${json(g.out)}, expected ${json(m.outs)}`);
      must(m.seats.filter((p) => has(p.id)).length >= 2, 'a hand is going on with fewer than two players holding cards');
      // The 52 cards: in hands, on the pile, gone with a leaver, or never dealt. Each exactly once.
      const all = [...m.seats.flatMap((p) => g.hands[p.id]), ...m.played, ...m.leftWith, ...m.undealt];
      must(all.length === 52 && new Set(all).size === 52 && all.every((c) => Number.isInteger(c) && c >= 0 && c < 52), `the cards do not add up to one pack: ${all.length} cards, ${new Set(all).size} different`);
      if (!m.table) must(m.passed.size === 0, 'someone has passed in a trick that has not started');
      else must(m.table.by !== m.turn && !m.passed.has(m.table.by) && m.table.cards.every((c) => m.played.has(c)), 'the table does not make sense');
      // Never stuck: the turn has a deadline ahead of us, and reaching it changes something.
      must(g.until === m.deadline && (owed || g.until > now) && g.until <= now + TURN_MS, `turn deadline is ${g.until - now} ms away`);
      const later = structuredClone(g);
      must(tlTick(later, g.until) && json(later) !== json(g), 'the turn deadline does not move the game on');
    } else {
      must(g.turn === null && json(g.hands) === '{}' && g.passed.length === 0 && g.out.length === 0 && g.mustInclude === null && !g.opening, `a hand that is not being played still has ${json({ turn: g.turn, hands: g.hands, passed: g.passed, out: g.out, must: g.mustInclude, opening: g.opening })}`);
    }
    if (m.phase === 'lobby') must(g.results === null && g.winner === null && g.table === null, 'the lobby shows an old hand');
    if (m.phase === 'ended') {
      const rows = g.results!;
      must(rows && json(rows.map((x) => x.id)) === json(m.order), `results list ${json(rows?.map((x) => x.id))}, expected ${json(m.order)}`);
      must(g.winner?.id === m.order![0], `winner is ${g.winner?.id}`);
      rows.forEach((row, i) => {
        must(json(row.cards) === json(m.leftover.get(row.id) ?? []), `${row.id} is shown holding ${json(row.cards)}`);
        const place = m.instant ? (i === 0 ? PLACES[0] : '') : i === 0 ? PLACES[0] : i === rows.length - 1 ? PLACES[3] : PLACES[i];
        must(row.place === place, `${row.id} in position ${i} of ${rows.length} is called "${row.place}"`);
        if (m.instant) must(i === 0 ? row.note?.startsWith('Tới trắng') : row.note === null, `instant win note is ${row.note}`);
        else {
          const thoi = m.outs.some((o) => o.id === row.id && o.thoi);
          must(!!row.note?.startsWith('Thối:') === thoi, `${row.id} ${thoi ? 'should' : 'should not'} be marked thối: ${row.note}`);
          const twos = row.cards.filter((c) => rk(c) === DEUCE).length;
          must(!!row.note?.startsWith('Thối heo') === twos > 0, `${row.id} holds ${twos} 2s but the note is ${row.note}`);
        }
      });
      const all = [...rows.flatMap((x) => x.cards), ...m.played, ...m.leftWith, ...m.undealt];
      must(all.length === 52 && new Set(all).size === 52, `after the hand the cards do not add up to one pack: ${all.length}, ${new Set(all).size} different`);
    }
    // Views: for each person, and for nobody in particular.
    for (const id of [null, ...room.people.map((p) => p.id)]) {
      const v = tlView(g, id, now);
      scan(v, [], 'view');
      must(v.left >= 0 && v.left <= TURN_MS && (v.left === 0 || v.phase === 'play'), `left is ${v.left}`);
      must(v.players.every((p) => p.count === (m.hands.get(p.id)?.length ?? 0)), 'card counts are wrong');
    }
  };

  /** Everything the server sent since `mark`: exactly one private view each when something changed, and no secrets in any. */
  const said = (mark: number, want: Sent[], what: string) => {
    const got = room.out.slice(mark);
    must(serverDraws === shadowDraws, `server drew ${serverDraws} random numbers, the rules ${shadowDraws}`);
    must(json(got) === json(JSON.parse(json(want))), () => `${what}: the server sent ${json(got)} but should have sent ${json(want)}`);
    must(room.notices.length === notices, `${what}: ${room.notices.length} winners announced, expected ${notices}: ${room.notices.at(-1)}`);
    for (const { to, v } of got) {
      must(to !== null, 'the server broadcast a view');
      must(json(Object.keys(v).sort()) === json(VIEW_KEYS), `view has keys ${Object.keys(v)}`);
      for (const p of v.players) must(json(Object.keys(p).sort()) === json(['count', 'id', 'name', 'out', 'passed']), `a player row has keys ${Object.keys(p)}`);
      if (m.phase === 'play') {
        // During a hand the only cards in a message are the receiver's own, the play on the table and the opening card.
        must(v.results === null, 'results sent during a hand');
        must(json(v.hand) === json(seated(to) ? m.hands.get(to) : null), `${to} was sent the hand ${json(v.hand)}`);
        must(v.table === null || (json(Object.keys(v.table).sort()) === json(['by', 'cards', 'name']) && v.table.cards.every((c: number) => m.played.has(c))), 'the table shows cards that were not played');
        must(m.variant === 'nam' || v.mustInclude === null, 'mustInclude in the north');
      } else must(v.hand === null, `${to} was sent a hand outside a hand`);
    }
  };
  const everyone = (changed: boolean): Sent[] => (changed ? room.people.map((p) => ({ to: p.id, v: tlView(g, p.id, now) })) : []);

  const act = (p: PlayerInfo, action: Record<string, unknown>) => {
    const k = action.k;
    // What should happen, by my own reading of the rules.
    let want = false;
    if (k === 'join') want = m.phase !== 'play' && m.seats.length < TL_MAX && !seated(p.id);
    else if (k === 'leave') want = seated(p.id);
    else if (k === 'deal') want = m.phase !== 'play' && seated(p.id) && m.seats.length >= TL_MIN;
    else if (k === 'variant') want = m.phase !== 'play' && seated(p.id) && (action.v === 'nam' || action.v === 'bac') && action.v !== m.variant;
    else if (k === 'pass') want = m.phase === 'play' && m.turn === p.id && !!m.table;
    else if (k === 'play') want = canPlay(p.id, action.cards);
    const before = json(g);
    let changed = false;
    let result: unknown = null;
    if (k === 'join') changed = tlJoin(g, p);
    else if (k === 'leave') changed = tlLeave(g, p.id, now);
    else if (k === 'deal') changed = tlDeal(g, p.id, now, rnd);
    else if (k === 'variant') changed = tlVariant(g, p.id, action.v);
    else if (k === 'pass') changed = tlPass(g, p.id, now);
    else if (k === 'play') changed = !!(result = tlPlay(g, p.id, action.cards, now));
    must(changed === want, `rules ${changed ? 'accepted' : 'refused'} it (table ${json(m.table)}, hand ${json(m.hands.get(p.id))}, ${m.variant}, turn ${m.turn})`);
    if (!changed) {
      stats.refused++;
      must(json(g) === before, 'a refused action changed the state');
    } else if (k === 'join') m.seats.push({ id: p.id, name: p.name });
    else if (k === 'leave') modelLeave(p.id);
    else if (k === 'deal') modelDeal();
    else if (k === 'variant') m.variant = action.v as Variant;
    else if (k === 'pass') modelPass(p.id);
    else if (k === 'play') {
      const expected = modelPlay(p.id, action.cards as number[]);
      must(result === expected, `tlPlay said ${result}, expected ${expected}`);
    }
    compare();
    const mark = room.out.length;
    server.onAction({ ...p }, action, now);
    serverStack = [];
    shadowStack = [];
    said(mark, everyone(changed), 'action');
  };

  const tick = () => {
    const due = m.phase === 'play' && now >= m.deadline;
    const changed = tlTick(g, now);
    must(changed === due, `tick ${changed ? 'changed' : 'did not change'} the game`);
    if (due) {
      stats.timeouts++;
      const by = m.turn!;
      // An idle player passes if they can, and otherwise leads their lowest card, which must always be allowed.
      if (m.table) modelPass(by);
      else {
        const low = [m.hands.get(by)![0]];
        must(canPlay(by, low), `the lowest card ${low} is not a legal lead for ${by}`);
        modelPlay(by, low);
      }
    }
    compare();
    const mark = room.out.length;
    server.tick!(now);
    said(mark, everyone(changed), 'tick');
  };

  const leaveRoom = (id: string) => {
    room.exit(id);
    const want = seated(id);
    const changed = tlLeave(g, id, now);
    must(changed === want, `leaving the room ${changed ? 'changed' : 'did not change'} the table`);
    if (changed) modelLeave(id);
    compare();
    const mark = room.out.length;
    server.onLeave(id, now);
    said(mark, everyone(changed), 'leaving the room');
  };

  /** Left entirely to the clock, any hand finishes. Tried on a copy, so the real game carries on. */
  const drains = () => {
    const c = structuredClone(g);
    for (let i = 0; i < 400 && c.phase === 'play'; i++) must(tlTick(c, c.until + (i % 3)), 'the clock stopped moving a hand on');
    must(c.phase === 'ended', 'an abandoned hand never finished');
    stats.drains++;
  };

  const leaveRate = pick(r, [0, 0.004, 0.015, 0.05]);
  const steps = 120 + int(r, 500);
  for (let i = 0; i < steps; i++) {
    const anyone = room.people.length ? pick(r, room.people) : null;
    const person = (id: string | null | undefined) => room.people.find((p) => p.id === id) ?? null;
    const sitter = () => person(m.seats.length ? pick(r, m.seats).id : null) ?? anyone!;
    const playing = m.phase === 'play';
    const x = r();
    if (playing && !owed && chance(r, 0.03)) {
      now = m.deadline + int(r, 101);
      owed = true;
      stats.late++;
      trail.push('the deadline passes, but the server has not ticked yet');
    }
    if (!anyone || (room.people.length < 7 && r() < (playing ? 0.012 : 0.1))) {
      const p = room.enter();
      trail.push(`${p.id} enters the room`);
      const mark = room.out.length;
      server.onJoin!({ ...p }, now);
      // A newcomer hears about the table only if somebody is at it, and gets no hand.
      said(mark, g.players.length ? [{ to: p.id, v: tlView(g, p.id, now) }] : [], 'entering the room');
      compare();
    } else if (!playing) {
      if (x < 0.03) {
        trail.push(`${anyone.id} leaves the room`);
        leaveRoom(anyone.id);
      } else if (x < 0.33) {
        trail.push(`${anyone.id} sits down`);
        act(anyone, { k: 'join' });
        if (chance(r, 0.15)) act(anyone, { k: 'join' });
      } else if (x < 0.38) {
        trail.push(`${anyone.id} stands up`);
        act(anyone, { k: 'leave' });
        if (chance(r, 0.5)) act(anyone, { k: 'join' });
      } else if (x < 0.48) {
        const v = chance(r, 0.85) ? pick(r, ['nam', 'bac']) : garbage(r);
        const p = chance(r, 0.85) ? sitter() : anyone;
        trail.push(`${p.id} asks for variant ${typeof v === 'string' ? v.slice(0, 10) : typeof v}`);
        act(p, { k: 'variant', v });
      } else if (x < 0.86) {
        const p = chance(r, 0.9) ? sitter() : anyone;
        const rigged = chance(r, 0.3);
        if (rigged) {
          serverStack = stack(riggedDeck(r));
          shadowStack = [...serverStack];
          stats.stacked++;
        }
        trail.push(`${p.id} deals${rigged ? ' a stacked deck' : ''} (${m.variant}, ${m.seats.length} seated)`);
        act(p, { k: 'deal' });
      } else if (x < 0.94) {
        const k = chance(r, 0.6) ? pick(r, ['pass', 'play', 'deal', 'start', 'toString', '__proto__']) : garbage(r);
        trail.push(`${anyone.id} sends ${typeof k === 'string' ? k.slice(0, 12) : typeof k} between hands`);
        act(anyone, { k, cards: chance(r, 0.5) ? [int(r, 52)] : garbage(r), v: garbage(r) });
      } else {
        now += pick(r, [0, 1, 100, 5000, TURN_MS, TURN_MS * 3, 86_400_000]);
        trail.push('time passes between hands');
        tick();
      }
    } else if (x < leaveRate) {
      // Someone walks off mid-hand: the player on turn, the owner of the table, someone already out, or anyone.
      const outId = m.seats.find((p) => !has(p.id))?.id;
      const p = person(pick(r, [m.turn, m.turn, m.table?.by, outId, anyone.id])) ?? anyone;
      if (chance(r, 0.5)) {
        trail.push(`${p.id} leaves the room mid-hand (turn ${m.turn}, table by ${m.table?.by})`);
        leaveRoom(p.id);
      } else {
        trail.push(`${p.id} stands up mid-hand (turn ${m.turn}, table by ${m.table?.by})`);
        act(p, { k: 'leave' });
        if (chance(r, 0.6)) {
          trail.push(`${p.id} tries to sit straight back down`);
          act(p, { k: 'join' });
        }
      }
    } else if (x < leaveRate + 0.7) {
      // Sensible play: something legal if there is anything, otherwise pass.
      const p = person(m.turn)!;
      const hand = m.hands.get(p.id)!;
      const legal = candidates(hand, m.variant, r).filter((cards) => canPlay(p.id, cards));
      if (legal.length && (!m.table || chance(r, 0.9))) {
        const most = Math.max(...legal.map((c) => c.length));
        const cards = chance(r, 0.4) ? pick(r, legal.filter((c) => c.length === most)) : pick(r, legal);
        if (chance(r, 0.5)) cards.reverse();
        trail.push(`${p.id} plays ${json(cards)} on ${json(m.table?.cards ?? null)} (${m.variant})`);
        act(p, { k: 'play', cards });
      } else {
        trail.push(`${p.id} passes`);
        act(p, { k: 'pass' });
      }
    } else if (x < leaveRate + 0.82) {
      // Hostile plays: junk, cards not held, cards that do not go together or do not beat the table, out of turn.
      const p = chance(r, 0.7) ? person(m.turn)! : anyone;
      const hand = m.hands.get(p.id) ?? [];
      const other = m.hands.get(pick(r, m.seats).id) ?? [];
      const some = (xs: readonly number[], n: number) => Array.from({ length: Math.min(n, xs.length) }, () => pick(r, xs));
      const kind = int(r, 9);
      let cards: unknown;
      if (kind === 0) cards = garbage(r);
      else if (kind === 1) cards = Array.from({ length: 1 + int(r, 5) }, () => int(r, 52));
      else if (kind === 2) cards = [...new Set(some(hand, 1 + int(r, 5)))];
      else if (kind === 3) cards = hand.length ? [hand[0], hand[0]] : [];
      else if (kind === 4) cards = [...new Set(some(other, 1 + int(r, 3)))];
      else if (kind === 5) cards = hand.slice(0, 2).map(String);
      else if (kind === 6) cards = [...hand.slice(0, 1), pick(r, [NaN, -1, 52, 0.5, 1e9, null, '3', [0], {}])];
      else if (kind === 7) cards = Array.from({ length: 1 + int(r, 3) }, () => garbage(r));
      else cards = pick(r, candidates(hand.length ? hand : [0], m.variant, r));
      trail.push(`${p.id} tries ${json(cards)?.slice(0, 60)} on ${json(m.table?.cards ?? null)} (turn ${m.turn})`);
      act(p, { k: 'play', cards });
    } else if (x < leaveRate + 0.88) {
      const k = pick(r, ['pass', 'deal', 'join', 'variant', 'pass']);
      trail.push(`${anyone.id} tries ${k} mid-hand (turn ${m.turn})`);
      act(anyone, { k, v: pick(r, ['nam', 'bac']) });
    } else if (x < leaveRate + 0.91) {
      const action = chance(r, 0.3) ? (Object.assign(Object.create({ k: 'play', cards: [0] }), { v: garbage(r) }) as Record<string, unknown>) : { k: garbage(r), cards: garbage(r), v: garbage(r) };
      trail.push(`${anyone.id} sends junk mid-hand`);
      act(anyone, action);
    } else {
      const d = m.deadline - now;
      const dt = Math.max(0, pick(r, [0, 1, 100, 100, 3000, d - 1, d, d + 1, TURN_MS * 3, 86_400_000]));
      now += dt;
      trail.push(`time +${dt}`);
      tick();
    }
    if (owed) {
      trail.push('the late tick');
      owed = false;
      tick();
    }
    if (m.phase === 'play' && chance(r, 0.03)) drains();
    stats.steps++;
  }

  // Left alone, a hand in progress plays itself out on time-outs.
  trail.push('everyone goes quiet');
  for (let guard = 0; m.phase === 'play'; guard++) {
    must(guard < 400, 'an abandoned hand never finished');
    now = m.deadline + int(r, 3);
    tick();
  }
  // Then the room empties, in any order, and the table ends up as new.
  while (room.people.length) {
    const p = pick(r, room.people);
    trail.push(`${p.id} leaves the room at the end`);
    leaveRoom(p.id);
  }
  must(json(g) === json(newTienlen()), `an empty room left the table as ${json(g)}`);
  now += 86_400_000;
  tick();
  stats.sessions++;
}

test(`tienlen: ${RUNS} seeded sessions of random and hostile play`, () => {
  simulate('tienlen', session);
  console.log(`tienlen sim: ${json(stats)}`);
  expect(stats.sessions).toBe(RUNS);
  // The run is only worth something if the interesting things really happened.
  if (RUNS >= 300) {
    for (const k of ['dealsNam', 'dealsBac', 'instant', 'endedByPlay', 'endedByLeave', 'chops', 'thoi', 'timeouts', 'refused', 'trickResets', 'sai', 'leavesMidHand'] as const) expect(stats[k], k).toBeGreaterThan(0);
    expect(stats.endedByPlay).toBeGreaterThan(RUNS);
  }
}, 3_600_000);
