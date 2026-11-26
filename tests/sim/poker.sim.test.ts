// Randomised poker simulation: whole table sessions played through the pure rules with a seeded
// generator, mixing sensible play with illegal actions, walk-outs, skips and new hands, and checking
// invariants after every step.
//
//   SIM_RUNS=50000 npx vitest run tests/sim/poker.sim.test.ts     play at least that many hands
//   SIM_SEED=1234 SIM_RUNS=1 npx vitest run tests/sim/poker.sim.test.ts     replay one failing session
import { expect, test } from 'vitest';
import { SKIP_AFTER_MS, type Card } from '../../shared/cards';
import {
  BIG_BLIND,
  BUY_IN,
  SMALL_BLIND,
  betting,
  compareScores,
  newPoker,
  pokerAct,
  pokerLeave,
  pokerSkip,
  pokerSkipIn,
  pokerStart,
  potOf,
  raiseRange,
  scoreHand,
  type PokerAction,
  type PokerGame,
} from '../../shared/poker';

// No Node typings in this project, so reach for the environment by hand.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Math.max(1, Number(env.SIM_RUNS) || 5000);
const SEED = Number(env.SIM_SEED) || 1;

/** A small seeded generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ an independent hand evaluator

const ORDER = '23456789TJQKA';
const val = (c: Card) => ORDER.indexOf(c[0]) + 2;

/** Score exactly five cards, written without looking at how the rules do it. */
function score5(cards: Card[]): number[] {
  const v = cards.map(val).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const distinct = new Set(v).size === 5;
  let straight = 0;
  if (distinct && v[0] - v[4] === 4) straight = v[0];
  else if (distinct && v[0] === 14 && v[1] === 5 && v[4] === 2) straight = 5;
  const counts = new Map<number, number>();
  for (const x of v) counts.set(x, (counts.get(x) ?? 0) + 1);
  // Ranks ordered by how many there are, then by rank.
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map((g) => g[1]).join('');
  const ranks = groups.map((g) => g[0]);
  if (straight && flush) return [8, straight];
  if (shape === '41') return [7, ...ranks];
  if (shape === '32') return [6, ...ranks];
  if (flush) return [5, ...v];
  if (straight) return [4, straight];
  if (shape === '311') return [3, ...ranks];
  if (shape === '221') return [2, ...ranks];
  if (shape === '2111') return [1, ...ranks];
  return [0, ...v];
}

const lex = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** The best five of up to seven cards, by trying every combination. */
function bruteBest(cards: Card[]): number[] {
  let best: number[] = [-1];
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (lex(s, best) > 0) best = s;
          }
  return best;
}

const FULL_DECK: Card[] = [];
for (const s of 'SHDC') for (const r of 'A23456789TJQK') FULL_DECK.push(r + s);

function deal(rnd: () => number, n: number): Card[] {
  const d = [...FULL_DECK];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (d.length - i));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d.slice(0, n);
}

test(`hand ranking agrees with a brute-force best-five-of-seven evaluator (${RUNS * 10} random hands, seed ${SEED})`, () => {
  const rnd = rng(SEED ^ 0x5eed);
  const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  for (let i = 0; i < RUNS * 10; i++) {
    // Sometimes share a board between the three hands, as at a real table, so that ties and near-ties happen.
    const cards = deal(rnd, 21);
    const shared = rnd() < 0.7 ? cards.slice(0, 5) : null;
    const hands = [0, 1, 2].map((k) => (shared ? [...cards.slice(5 + k * 2, 7 + k * 2), ...shared] : cards.slice(k * 7, k * 7 + 7)));
    const [a, b, c] = hands.map((h) => scoreHand(h));
    const brute = hands.map(bruteBest);
    const where = `seed ${SEED}, hand ${i}: ${hands.map((h) => h.join(' ')).join(' | ')}`;
    hands.forEach((h, k) => expect([a, b, c][k], `${where} (hand ${k})`).toEqual(brute[k]));
    // The order of the cards must not matter.
    const shuffled = [...hands[0]].sort(() => rnd() - 0.5);
    expect(scoreHand(shuffled), `card order changed the score: ${where}`).toEqual(a);
    // Antisymmetric, reflexive, transitive, and the same order as the brute-force evaluator.
    expect(compareScores(a, a), where).toBe(0);
    expect(sign(compareScores(a, b)) + sign(compareScores(b, a)), `not antisymmetric: ${where}`).toBe(0);
    expect(sign(compareScores(a, b)), `disagrees with brute force: ${where}`).toBe(sign(lex(brute[0], brute[1])));
    expect(sign(compareScores(b, c)), `disagrees with brute force: ${where}`).toBe(sign(lex(brute[1], brute[2])));
    if (compareScores(a, b) >= 0 && compareScores(b, c) >= 0) expect(compareScores(a, c) >= 0, `not transitive: ${where}`).toBe(true);
    if (compareScores(a, b) <= 0 && compareScores(b, c) <= 0) expect(compareScores(a, c) <= 0, `not transitive: ${where}`).toBe(true);
    if (compareScores(a, b) === 0 && compareScores(b, c) === 0) expect(compareScores(a, c), `ties not transitive: ${where}`).toBe(0);
  }
}, 600_000);

// ------------------------------------------------------------ whole sessions

interface Stats {
  hands: number;
  steps: number;
  accepted: number;
  refused: number;
  showdowns: number;
  foldWins: number;
  sidePots: number;
  splitPots: number;
  leaves: number;
  skips: number;
  rebuys: number;
  runOuts: number;
  /** Times a player who had already acted faced an all-in too small to let them raise again. */
  callOnly: number;
  longestHand: number;
}

/** The most accepted actions a hand may take before the test calls it stuck. */
const HAND_ACTION_LIMIT = 400;

function session(seed: number, stats: Stats) {
  const rnd = rng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  const trail: string[] = [];
  const g: PokerGame = newPoker();
  let now = 1_000_000 + int(1000);
  let hand = 0;

  const fail = (msg: string): never => {
    throw new Error(
      `poker sim failed, seed ${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1), hand ${hand}: ${msg}\nlast steps:\n  ${trail.slice(-25).join('\n  ')}\nstate: ${JSON.stringify(g)}`,
    );
  };
  const must = (ok: boolean, msg: string) => {
    if (!ok) fail(msg);
  };

  const pool = Array.from({ length: 2 + int(6) }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
  const seated = new Set<string>();
  for (const p of pool) if (rnd() < 0.8) seated.add(p.id);
  // Uneven stacks, so that all-ins and side pots are common.
  for (const p of pool) if (rnd() < 0.6) g.bank[p.id] = pick([BIG_BLIND, 25, 60, 60, 200, 200, 1000, 1500, 5000]);
  /** Every chip that exists: banked, in a stack, or in the pot. */
  const allChips = () => {
    let sum = betting(g) ? potOf(g) : 0;
    const inHand = new Map(g.phase === 'lobby' ? [] : g.seats.map((s) => [s.id, s.chips] as const));
    for (const id of new Set([...Object.keys(g.bank), ...inHand.keys()])) sum += inHand.has(id) ? inHand.get(id)! : g.bank[id];
    return sum;
  };
  let ledger = allChips();

  /** Refused actions must leave the game exactly as it was. */
  const refused = (what: string, run: () => boolean) => {
    const before = JSON.stringify(g);
    let ok: boolean;
    try {
      ok = run();
    } catch (e) {
      return fail(`${what} threw: ${(e as Error).message}`);
    }
    trail.push(`refused? ${what} -> ${ok}`);
    must(ok === false, `${what} was accepted`);
    must(JSON.stringify(g) === before, `${what} was refused but changed the game`);
    stats.refused++;
  };

  let startChips = new Map<string, number>();
  let handTotal = 0;
  let accepted = 0;

  const checkShowdown = () => {
    const live = g.seats.filter((s) => !s.folded);
    must(live.length >= 1, 'a hand ended with everyone folded');
    must(g.turn === -1, 'turn still set at the showdown');
    must(g.results.length >= 1, 'no result line');
    for (const s of g.seats) must(g.bank[s.id] === s.chips, `bank of ${s.id} not updated`);
    const award = new Map<string, number>(g.seats.map((s) => [s.id, s.chips - (startChips.get(s.id)! - s.committed)]));
    for (const s of g.seats) {
      must(award.get(s.id)! >= 0, `${s.id} lost more than they put in`);
      if (s.folded) must(award.get(s.id) === 0, `${s.id} folded but was paid ${award.get(s.id)}`);
    }
    const pot = g.seats.reduce((sum, s) => sum + s.committed, 0);
    must([...award.values()].reduce((a, b) => a + b, 0) === pot, 'the awards do not add up to the pot');
    if (!g.shown) {
      must(live.length === 1, 'cards stayed hidden although more than one player was left');
      must(award.get(live[0].id) === pot, 'the last player standing did not get the whole pot');
      stats.foldWins++;
      return;
    }
    stats.showdowns++;
    must(live.length >= 2, 'a showdown with one player');
    must(g.board.length === 5, `showdown with ${g.board.length} board cards`);
    // Work the pots out again from scratch, with the brute-force evaluator.
    const score = new Map(live.map((s) => [s.id, bruteBest([...s.hole, ...g.board])]));
    const levels = [...new Set(live.map((s) => s.committed))].sort((a, b) => a - b);
    const expected = new Map<string, number>(g.seats.map((s) => [s.id, 0]));
    let prev = 0;
    let given = 0;
    levels.forEach((level, k) => {
      let amount = 0;
      for (const s of g.seats) amount += Math.max(0, Math.min(s.committed, level) - prev);
      // Anything a folded player put in above every remaining player goes with the last pot.
      if (k === levels.length - 1) amount = pot - given;
      given += amount;
      const eligible = live.filter((s) => s.committed >= level);
      let best = eligible[0];
      for (const s of eligible) if (lex(score.get(s.id)!, score.get(best.id)!) > 0) best = s;
      const winners = eligible.filter((s) => lex(score.get(s.id)!, score.get(best.id)!) === 0);
      const share = Math.floor(amount / winners.length);
      winners.forEach((w, i) => expected.set(w.id, expected.get(w.id)! + share + (i === 0 ? amount - share * winners.length : 0)));
      if (winners.length > 1 && amount > 0) stats.splitPots++;
      prev = level;
    });
    if (levels.length > 1) stats.sidePots++;
    const top = levels[levels.length - 1];
    for (const s of live) {
      must(award.get(s.id) === expected.get(s.id), `${s.id} was paid ${award.get(s.id)}, expected ${expected.get(s.id)}`);
      // Nobody takes more from each opponent than they put in themselves (the deepest player also gets dead money back).
      const cap = s.committed === top ? pot : g.seats.reduce((sum, o) => sum + Math.min(o.committed, s.committed), 0);
      must(award.get(s.id)! <= cap, `${s.id} won ${award.get(s.id)} from pots worth ${cap} to them`);
    }
  };

  const check = () => {
    stats.steps++;
    must(allChips() === ledger, `chips changed: ${allChips()} now, ${ledger} expected`);
    if (g.phase === 'lobby') return;
    const pot = potOf(g);
    const stacks = g.seats.reduce((sum, s) => sum + s.chips, 0);
    must(stacks + (betting(g) ? pot : 0) === handTotal, `hand total changed: stacks ${stacks}, pot ${pot}, was ${handTotal}`);
    for (const s of g.seats) {
      for (const [k, n] of [['chips', s.chips], ['bet', s.bet], ['committed', s.committed]] as const) {
        must(Number.isInteger(n) && n >= 0, `${s.id} has ${k} ${n}`);
      }
      must(s.bet <= s.committed, `${s.id} bet more this round than this hand`);
      must(s.chips + s.committed >= startChips.get(s.id)!, `${s.id} lost chips outside the pot`);
      must(s.hole.length === 2, `${s.id} holds ${s.hole.length} cards`);
    }
    // All 52 cards, each exactly once.
    const cards = [...g.deck, ...g.board, ...g.seats.flatMap((s) => s.hole)];
    must(cards.length === 52 && new Set(cards).size === 52 && cards.every((c) => FULL_DECK.includes(c)), `the cards are not one full deck (${cards.length}, ${new Set(cards).size} distinct)`);
    must(g.minRaise >= BIG_BLIND, `min raise ${g.minRaise}`);
    must(pokerSkipIn(g, now) >= 0 && pokerSkipIn(g, now) <= SKIP_AFTER_MS, 'skip countdown out of range');

    if (!betting(g)) {
      must(g.phase === 'showdown', `unexpected phase ${g.phase}`);
      must(pokerSkipIn(g, now) === 0, 'skip countdown running after the hand');
      return;
    }
    const boardFor = { preflop: 0, flop: 3, turn: 4, river: 5 } as const;
    must(g.board.length === boardFor[g.phase as keyof typeof boardFor], `${g.board.length} board cards in the ${g.phase}`);
    for (const s of g.seats) {
      must(s.bet <= g.currentBet, `${s.id} has bet more than the current bet`);
      must(s.allIn === (s.chips === 0), `${s.id} all-in flag ${s.allIn} with ${s.chips} chips`);
    }
    must(g.currentBet === Math.max(...g.seats.map((s) => s.bet)), 'current bet is not the largest bet');
    const live = g.seats.filter((s) => !s.folded);
    must(live.length >= 2, 'betting with fewer than two players left');
    const t = g.seats[g.turn];
    must(!!t, `turn ${g.turn} points at nobody`);
    must(!t.folded && !t.allIn, `turn points at ${t.id}, who cannot act`);
    must(!t.acted || t.bet < g.currentBet, `turn points at ${t.id}, who has nothing to decide`);
    // With everyone else all-in or gone there is nothing to decide unless there is a bet to answer.
    const others = g.seats.filter((s) => s !== t && !s.folded && !s.allIn).length;
    must(others >= 1 || t.bet < g.currentBet, `${t.id} is asked to act with nobody left to bet against and nothing to call`);
    must(g.turnSince <= now, 'turn clock is in the future');
    const range = raiseRange(g, t);
    if (range) must(range.min > g.currentBet && range.min <= range.max && range.max === t.bet + t.chips, `bad raise range ${JSON.stringify(range)}`);
  };

  const playHand = () => {
    hand++;
    // People come and go between hands.
    for (const p of pool) {
      if (rnd() < 0.12) {
        if (seated.delete(p.id)) pokerLeave(g, p.id, now);
        else seated.add(p.id);
      }
    }
    while (seated.size < 2) seated.add(pick(pool).id);
    const players = pool.filter((p) => seated.has(p.id));
    if (rnd() < 0.3) players.reverse();
    check();

    if (rnd() < 0.2) refused('dealing to one player', () => pokerStart(g, players.slice(0, 1), now));
    if (rnd() < 0.1) refused('dealing to nobody', () => pokerStart(g, [], now));
    if (rnd() < 0.1) refused('dealing the same player twice', () => pokerStart(g, [players[0], players[0]], now));
    if (rnd() < 0.2) refused('acting between hands', () => pokerAct(g, pick(pool).id, { k: 'call' }, now));
    if (rnd() < 0.2) refused('skipping between hands', () => pokerSkip(g, pick(pool).id, now + 10 * SKIP_AFTER_MS, [...seated]));

    // The only chips that may appear: a first buy-in, or a fresh one for somebody who is broke.
    startChips = new Map();
    for (const p of players) {
      const had = g.bank[p.id];
      if (had === undefined) ledger += BUY_IN;
      else if (had < BIG_BLIND) {
        ledger += BUY_IN - had;
        stats.rebuys++;
      }
      startChips.set(p.id, had === undefined || had < BIG_BLIND ? BUY_IN : had);
    }
    const previousDealer = g.dealerId;
    must(pokerStart(g, players, now) === true, 'could not deal');
    trail.push(`deal to ${players.map((p) => `${p.id}:${startChips.get(p.id)}`).join(' ')}`);
    stats.hands++;
    accepted = 0;
    handTotal = [...startChips.values()].reduce((a, b) => a + b, 0);
    must(g.seats.length === players.length && g.seats.every((s, i) => s.id === players[i].id), 'not everyone was dealt in');
    must(g.turnSince === now, 'turn clock not started at the deal');
    must(g.seats[g.dealer]?.id === g.dealerId, 'dealer id and seat disagree');
    const prevIndex = players.findIndex((p) => p.id === previousDealer);
    if (prevIndex >= 0) must(g.dealer === (prevIndex + 1) % players.length, 'the button did not move on one seat');
    // Blinds: the two seats after the button (heads-up, the button posts the small one).
    const n = players.length;
    const sb = n === 2 ? g.dealer : (g.dealer + 1) % n;
    const bb = (sb + 1) % n;
    must(g.seats[sb].committed === Math.min(SMALL_BLIND, startChips.get(g.seats[sb].id)!), 'small blind not posted');
    must(g.seats[bb].committed === Math.min(BIG_BLIND, startChips.get(g.seats[bb].id)!), 'big blind not posted');
    must(potOf(g) === g.seats[sb].committed + g.seats[bb].committed, 'someone other than the blinds paid');
    check();

    const sawBetting = betting(g);
    while (betting(g)) {
      now += rnd() < 0.5 ? int(3000) : int(70_000);
      const t = g.seats[g.turn];
      const roll = rnd();
      const calm = accepted > 150; // a very long hand: stop raising so it has to finish
      if (accepted > HAND_ACTION_LIMIT) fail(`the hand did not end within ${HAND_ACTION_LIMIT} actions`);

      if (roll < 0.05) {
        // Somebody walks away from the table: sometimes the player to act, sometimes someone already gone.
        const who = rnd() < 0.4 ? t : pick(g.seats);
        const wasLive = !who.folded;
        const turnBefore = g.turn;
        const sinceBefore = g.turnSince;
        seated.delete(who.id);
        pokerLeave(g, who.id, now);
        trail.push(`${who.id} leaves`);
        stats.leaves++;
        must(who.folded, 'a player who left is still in the hand');
        if (wasLive) must(g.bank[who.id] === who.chips, 'bank not kept for a player who left');
        if (betting(g) && !wasLive) must(g.turn === turnBefore && g.turnSince === sinceBefore, 'a folded player leaving moved the turn');
        if (betting(g) && who !== t && g.turn === turnBefore) must(g.turnSince === sinceBefore, 'someone else leaving restarted the turn clock');
        if (betting(g) && who === t) must(g.turnSince === now, 'turn clock not restarted after the player to act left');
      } else if (roll < 0.08) {
        // Somebody sits down mid-hand (they wait), or a player who left comes back (still folded).
        seated.add(pick(pool).id);
        trail.push('someone sits down');
      } else if (roll < 0.2) {
        // Things that must be refused.
        const kind = int(14);
        const other = pick(g.seats.filter((s) => s !== t));
        const range = raiseRange(g, t);
        if (kind === 0) refused(`${other.id} acting out of turn`, () => pokerAct(g, other.id, pick<PokerAction>([{ k: 'fold' }, { k: 'call' }, { k: 'raise', to: g.currentBet + g.minRaise }]), now));
        else if (kind === 1) refused('a stranger acting', () => pokerAct(g, pick(['', 'nobody', 'toString', '__proto__']), { k: 'call' }, now));
        else if (kind === 2) refused('raise to a non-number', () => pokerAct(g, t.id, { k: 'raise', to: pick([NaN, Infinity, -Infinity, '100', null, undefined, {}, [200]]) as number }, now));
        else if (kind === 3) refused('raise to the current bet or less', () => pokerAct(g, t.id, { k: 'raise', to: pick([g.currentBet, g.currentBet - 1, 0, -50, t.bet]) }, now));
        else if (kind === 4) refused('raise to more than the stack', () => pokerAct(g, t.id, { k: 'raise', to: t.bet + t.chips + 1 + int(1000) }, now));
        else if (kind === 5) {
          if (range && range.min - 1 > g.currentBet) refused('raise below the minimum', () => pokerAct(g, t.id, { k: 'raise', to: range.min - 1 - int(range.min - 1 - g.currentBet) }, now));
          else if (!range) refused('raise when raising is not allowed', () => pokerAct(g, t.id, { k: 'raise', to: Math.max(g.currentBet + g.minRaise, t.bet + t.chips) }, now));
        } else if (kind === 6) refused('a garbage action', () => pokerAct(g, t.id, pick([null, undefined, 7, 'fold', {}, { k: 'deal' }, { k: 'skip' }, { k: 'check' }, { k: 'raise' }, []]) as unknown as PokerAction, now));
        else if (kind === 7) refused('dealing during a hand', () => pokerStart(g, pool.slice(0, 2), now));
        else if (kind === 8) refused('skipping too early', () => pokerSkip(g, other.id, g.turnSince + int(SKIP_AFTER_MS), [...seated, other.id]));
        else if (kind === 9) refused('skipping yourself', () => pokerSkip(g, t.id, g.turnSince + SKIP_AFTER_MS + int(100_000), [...seated, t.id]));
        else if (kind === 10) refused('a skip from someone not at the table', () => pokerSkip(g, other.id, g.turnSince + SKIP_AFTER_MS + int(100_000), [...seated].filter((id) => id !== other.id)));
        else if (kind === 11) refused('a skip from a stranger', () => pokerSkip(g, 'nobody', g.turnSince + SKIP_AFTER_MS + 1, [...seated]));
        else if (kind === 12) refused('a skip with a garbage clock', () => pokerSkip(g, other.id, pick([NaN, -1, undefined as unknown as number, 0]), [...seated, other.id]));
        else refused('a skip with no table list', () => pokerSkip(g, other.id, g.turnSince + SKIP_AFTER_MS, undefined as unknown as string[]));
      } else if (roll < 0.26) {
        // A real skip by somebody else at the table, once the wait is over.
        const by = pick(g.seats.filter((s) => s !== t));
        now = Math.max(now, g.turnSince + SKIP_AFTER_MS + (rnd() < 0.3 ? 0 : int(60_000)));
        const owed = g.currentBet > t.bet;
        const before = { chips: t.chips, phase: g.phase, turn: g.turn };
        must(pokerSkipIn(g, now) === 0, 'skip countdown not finished');
        must(pokerSkip(g, by.id, now, [...seated, by.id]) === true, `a late skip of ${t.id} by ${by.id} was refused`);
        trail.push(`${by.id} skips ${t.id} (${owed ? 'fold' : 'check'})`);
        stats.skips++;
        accepted++;
        must(t.folded === owed, owed ? 'a skipped player facing a bet did not fold' : 'a skipped player who could check was folded');
        must(t.chips === before.chips || !betting(g), 'a skip cost the skipped player chips');
        must(!betting(g) || g.turn !== before.turn || g.phase !== before.phase, 'the turn did not move after a skip');
        if (betting(g)) must(g.turnSince === now, 'turn clock not restarted after a skip');
      } else {
        if (t.acted && t.bet + t.chips > g.currentBet && !raiseRange(g, t)) stats.callOnly++;
        const range = calm ? null : raiseRange(g, t);
        let a: PokerAction;
        if (roll < 0.36) a = { k: 'fold' };
        else if (roll < 0.72 || !range) a = { k: 'call' };
        else {
          const style = rnd();
          const to = style < 0.3 ? range.min : style < 0.45 ? range.max : style < 0.8 ? Math.min(range.max, range.min + int(120)) : range.min + int(range.max - range.min + 1);
          a = { k: 'raise', to: rnd() < 0.1 ? to + 0.75 * (to < range.max ? 1 : 0) : to };
        }
        const before = { bet: t.bet, chips: t.chips, current: g.currentBet, phase: g.phase, turn: g.turn, acted: t.acted, faced: t.facedBet, minRaise: g.minRaise };
        must(pokerAct(g, t.id, a, now) === true, `${t.id} ${JSON.stringify(a)} was refused`);
        trail.push(`${t.id} ${JSON.stringify(a)} (bet ${before.bet}, to match ${before.current})`);
        stats.accepted++;
        accepted++;
        const paid = before.chips - (betting(g) ? t.chips : before.chips - (t.committed - (startChips.get(t.id)! - before.chips)));
        if (a.k === 'fold') must(t.folded && t.committed === startChips.get(t.id)! - before.chips, 'a fold cost chips or did not fold');
        if (a.k === 'call') must(!t.folded && paid === Math.min(before.current - before.bet, before.chips), `a call paid ${paid}`);
        if (a.k === 'raise') {
          must(paid === Math.floor(a.to) - before.bet, `a raise to ${a.to} paid ${paid}`);
          // Someone who has already acted may only raise again when facing a full raise.
          must(!before.acted || before.current - before.faced >= before.minRaise, 'a raise was allowed after an all-in for less than a full raise');
        }
        must(!betting(g) || g.turn !== before.turn || g.phase !== before.phase, 'the same player is asked again straight away');
        if (betting(g)) must(g.turnSince === now, 'turn clock not restarted after an action');
      }
      check();
    }
    check();
    if (sawBetting && g.seats.filter((s) => !s.folded && s.allIn).length >= 1 && g.shown) stats.runOuts++;
    stats.longestHand = Math.max(stats.longestHand, accepted);
    checkShowdown();
    // After the hand nothing but a new deal changes anything.
    if (rnd() < 0.3) refused('acting after the hand', () => pokerAct(g, pick(g.seats).id, { k: 'call' }, now));
    if (rnd() < 0.3) refused('skipping after the hand', () => pokerSkip(g, pick(g.seats).id, now + 10 * SKIP_AFTER_MS, [...seated, ...g.seats.map((s) => s.id)]));
    if (rnd() < 0.3) {
      const before = JSON.stringify(g);
      pokerLeave(g, pick(g.seats).id, now);
      must(JSON.stringify(g) === before, 'leaving after the hand changed it');
    }
  };

  // Shuffles use Math.random: make them repeatable for this seed.
  const realRandom = Math.random;
  Math.random = rnd;
  try {
    const hands = 1 + int(6);
    for (let h = 0; h < hands; h++) playHand();
  } finally {
    Math.random = realRandom;
  }
}

test(`poker: at least ${RUNS} random hands keep every invariant (first seed ${SEED})`, () => {
  const stats: Stats = { hands: 0, steps: 0, accepted: 0, refused: 0, showdowns: 0, foldWins: 0, sidePots: 0, splitPots: 0, leaves: 0, skips: 0, rebuys: 0, runOuts: 0, callOnly: 0, longestHand: 0 };
  const started = Date.now();
  let sessions = 0;
  while (stats.hands < RUNS) session(SEED + sessions++, stats);
  console.log(`poker sim: ${stats.hands} hands in ${sessions} sessions, ${((Date.now() - started) / 1000).toFixed(1)}s`, JSON.stringify(stats));
  // The simulation is only worth something if it reaches the interesting situations.
  if (RUNS >= 1000) {
    expect(stats.showdowns).toBeGreaterThan(RUNS / 20);
    expect(stats.sidePots).toBeGreaterThan(RUNS / 100);
    expect(stats.splitPots).toBeGreaterThan(0);
    expect(stats.skips).toBeGreaterThan(RUNS / 20);
    expect(stats.leaves).toBeGreaterThan(RUNS / 20);
    expect(stats.rebuys).toBeGreaterThan(0);
    expect(stats.callOnly).toBeGreaterThan(0);
  }
}, 600_000);
