// Randomised simulation of the rooftop duel: thousands of whole duels through the rule functions,
// with fighters who pick sensibly, late, twice, or not at all, strangers butting in, garbage moves,
// people walking off at every possible moment and the clock jumping forward. Checked after every
// step. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/duel.sim.test.ts
import { expect, test } from 'vitest';
import {
  HEARTS,
  MAX_ROUNDS,
  MOVES,
  REVEAL_MS,
  ROUND_MS,
  duelForfeit,
  duelPick,
  duelTick,
  duelView,
  newDuel,
  type Duel,
  type Move,
} from '../../shared/duel';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 20000;
const SEED = Number(ENV.SIM_SEED) || 1;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reads the phase afresh: the rule functions change it behind the type checker's back. */
const phaseOf = (x: { phase: string }) => x.phase;

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// The rules, restated: each move beats exactly one other; no move loses to any move; two the same tie.
const BEATS: Record<string, string> = { pillow: 'chicken', chicken: 'umbrella', umbrella: 'pillow' };
function loserOf(a: Move | null, b: Move | null): 'a' | 'b' | null {
  if (a === b) return null;
  if (!a) return 'a';
  if (!b) return 'b';
  return BEATS[a] === b ? 'b' : 'a';
}

const GARBAGE: unknown[] = ['sword', '', 'PILLOW', ' pillow', 0, 1, NaN, null, undefined, {}, [], ['pillow'], true, 'toString', '__proto__'];

interface Stats {
  duels: number;
  steps: number;
  refused: number;
  rounds: number;
  wonOnHearts: number;
  forfeits: number;
  draws: number;
  wonOnPoints: number;
  timeouts: number;
  maxRound: number;
}

function invariants(d: Duel, now: number) {
  for (const f of [d.a, d.b]) {
    check(Number.isInteger(f.hearts) && f.hearts >= 0 && f.hearts <= HEARTS, `${f.id} has ${f.hearts} hearts`);
    check(f.pick === null || MOVES.includes(f.pick), `${f.id} holds a move of ${String(f.pick)}`);
  }
  check(d.a.hearts > 0 || d.b.hearts > 0, 'both fighters are out of hearts');
  check(Number.isInteger(d.round) && d.round >= 1 && d.round <= MAX_ROUNDS, `round ${d.round}`);
  check(Number.isFinite(d.until), `the clock is ${d.until}`);
  if (d.phase === 'over') {
    check(d.winner === d.a.id || d.winner === d.b.id || d.winner === '', `the winner is ${String(d.winner)}`);
  } else {
    check(d.winner === null, 'a winner was named before the end');
    check(d.a.hearts > 0 && d.b.hearts > 0, 'the duel goes on with someone out of hearts');
  }
  if (d.phase !== 'pick') check(d.phase === 'over' || (d.a.pick === null && d.b.pick === null), 'a move was carried into the reveal');

  // What everyone is shown: never this round's moves, only whether each fighter is ready.
  const v = duelView(d, now);
  check(v.a.ready === !!d.a.pick && v.b.ready === !!d.b.pick && v.left >= 0 && Number.isFinite(v.left), 'the view is wrong');
  if (d.phase === 'pick') {
    // Swap the hidden moves for different ones: not one byte of the view may change.
    const twin = structuredClone(d);
    if (twin.a.pick) twin.a.pick = MOVES[(MOVES.indexOf(twin.a.pick) + 1) % 3];
    if (twin.b.pick) twin.b.pick = MOVES[(MOVES.indexOf(twin.b.pick) + 2) % 3];
    check(JSON.stringify(duelView(twin, now)) === JSON.stringify(v), 'the view depends on a move that should be hidden');
  }
}

function playDuel(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  let now = 1_700_000_000_000 + int(1e9);
  const d = newDuel(1 + int(1000), { id: 'ann', name: 'Ann' }, { id: 'bao', name: 'Bao' }, now);
  const fresh: Duel = d;
  check(fresh.phase === 'pick' && fresh.round === 1 && fresh.a.hearts === HEARTS && fresh.b.hearts === HEARTS && fresh.until === now + ROUND_MS, 'bad opening state');
  invariants(d, now);

  // How each fighter behaves: keen, slow (often runs out of time), asleep, or always the same move.
  const temper = () => pick(['keen', 'keen', 'slow', 'asleep', 'stubborn'] as const);
  const mood = { ann: temper(), bao: temper() };
  const favourite = { ann: pick([...MOVES]), bao: pick([...MOVES]) };
  const quitChance = pick([0, 0, 0.002, 0.02]);
  let forfeited: string | null = null;
  let roundsPlayed = 0;

  for (let step = 0; phaseOf(d) !== 'over'; step++) {
    check(step < 5000, 'the duel did not end');
    stats.steps++;
    const before = structuredClone(d);
    const r = rnd();
    let what: string;
    if (r < quitChance) {
      // Someone walks off: a fighter, or somebody who has nothing to do with it.
      const who = rnd() < 0.6 ? pick(['ann', 'bao']) : pick(['zed', '', 'Ann', 'toString']);
      what = `forfeit ${who}`;
      duelForfeit(d, who, now);
      if (who === 'ann' || who === 'bao') {
        check(phaseOf(d) === 'over' && d.winner === (who === 'ann' ? 'bao' : 'ann') && d.until === now + REVEAL_MS, 'walking off did not hand the other fighter the win');
        check(d.a.hearts === before.a.hearts && d.b.hearts === before.b.hearts && d.round === before.round, 'walking off changed the score');
        forfeited = who;
      } else {
        check(JSON.stringify(d) === JSON.stringify(before), 'a stranger ended or changed the duel');
        stats.refused++;
      }
    } else if (r < 0.45) {
      // A move from somebody: usually a fighter with a real move, sometimes not.
      const who = rnd() < 0.9 ? pick(['ann', 'bao'] as const) : pick(['zed', '', 'a', 'b']);
      const lazy = who in mood && ((mood as Record<string, string>)[who] === 'asleep' ? 0.97 : (mood as Record<string, string>)[who] === 'slow' ? 0.8 : 0);
      if (lazy && rnd() < lazy) continue;
      const move = rnd() < 0.85 ? ((mood as Record<string, string>)[who] === 'stubborn' ? (favourite as Record<string, Move>)[who] : pick([...MOVES])) : pick(GARBAGE);
      what = `pick ${who} ${JSON.stringify(move)}`;
      const f = who === 'ann' ? before.a : who === 'bao' ? before.b : null;
      const want = before.phase === 'pick' && !!f && f.pick === null && MOVES.includes(move as Move);
      const got = duelPick(d, who, move);
      check(got === want, `${what} returned ${got} but the rules say ${want}`);
      if (want) {
        (who === 'ann' ? before.a : before.b).pick = move as Move;
      } else stats.refused++;
      check(JSON.stringify(d) === JSON.stringify(before), `${what} changed more than that fighter's move`);
    } else {
      // Time passes (a little, a lot, or not at all, or the clock breaks) and the server ticks.
      const tr = rnd();
      const broken = tr > 0.985;
      if (!broken) now += tr < 0.15 ? 0 : tr < 0.75 ? int(900) : tr < 0.95 ? int(ROUND_MS * 2) : int(1e9);
      const at = broken ? pick([NaN, Infinity, -Infinity]) : now;
      what = `tick +${now - before.until} ms past the bell`;
      const got = duelTick(d, at);
      if (broken) {
        check(!got && JSON.stringify(d) === JSON.stringify(before), 'a broken clock moved the duel on');
      } else if (before.phase === 'pick') {
        const both = !!before.a.pick && !!before.b.pick;
        const want = both || now >= before.until;
        check(got === want, `a round ${got ? 'ended' : 'did not end'} with ${both ? 'both' : 'not both'} moves in, ${now - before.until} ms past the bell`);
        if (want) {
          roundsPlayed++;
          stats.rounds++;
          if (!both) stats.timeouts++;
          const loser = loserOf(before.a.pick, before.b.pick);
          check(d.a.hearts === before.a.hearts - (loser === 'a' ? 1 : 0) && d.b.hearts === before.b.hearts - (loser === 'b' ? 1 : 0), 'the wrong hearts were lost');
          check(JSON.stringify(d.last) === JSON.stringify({ a: before.a.pick, b: before.b.pick, loser: loser ? before[loser].id : '' }), 'the round was reported wrongly');
          check(d.a.pick === null && d.b.pick === null && d.round === before.round && d.until === now + REVEAL_MS, 'the round was not closed properly');
          const out = d.a.hearts === 0 || d.b.hearts === 0;
          check(phaseOf(d) === (out || before.round >= MAX_ROUNDS ? 'over' : 'reveal'), `after the round the phase is ${phaseOf(d)}`);
        }
      } else {
        const want = now >= before.until;
        check(got === want, `the reveal ${got ? 'ended' : 'did not end'} ${now - before.until} ms past its time`);
        if (want) check(d.phase === 'pick' && d.round === before.round + 1 && d.until === now + ROUND_MS && JSON.stringify([d.a, d.b, d.last]) === JSON.stringify([before.a, before.b, before.last]), 'the next round did not start cleanly');
      }
      if (!got) check(JSON.stringify(d) === JSON.stringify(before), 'a tick that did nothing changed the duel');
    }
    trace.push(`${step}: round ${before.round} ${before.phase} ${what}`);
    if (trace.length > 12) trace.shift();

    // Hearts only ever go down, one at a time, and only one fighter's per round.
    const lostA = before.a.hearts - d.a.hearts;
    const lostB = before.b.hearts - d.b.hearts;
    check(lostA >= 0 && lostB >= 0 && lostA + lostB <= 1, 'hearts moved the wrong way');
    check(d.id === before.id && d.a.id === 'ann' && d.b.id === 'bao' && d.round >= before.round, 'the duel itself changed');
    invariants(d, now);
  }

  // Exactly one of the documented endings.
  check(roundsPlayed <= MAX_ROUNDS && d.round <= MAX_ROUNDS, 'the duel ran past the round limit');
  if (forfeited) {
    stats.forfeits++;
  } else if (d.a.hearts === 0 || d.b.hearts === 0) {
    check(d.winner === (d.a.hearts === 0 ? 'bao' : 'ann'), 'the fighter with no hearts left did not lose');
    stats.wonOnHearts++;
  } else {
    check(d.round === MAX_ROUNDS && roundsPlayed === MAX_ROUNDS, 'the duel ended early for no reason');
    if (d.a.hearts === d.b.hearts) {
      check(d.winner === '', 'level on hearts but not a draw');
      stats.draws++;
    } else {
      check(d.winner === (d.a.hearts > d.b.hearts ? 'ann' : 'bao'), 'the fighter with more hearts did not win on points');
      stats.wonOnPoints++;
    }
  }
  stats.maxRound = Math.max(stats.maxRound, d.round);

  // Once it is over, nothing changes it.
  const done = JSON.stringify(d);
  check(!duelPick(d, 'ann', 'pillow') && !duelPick(d, 'bao', 'chicken') && !duelTick(d, now + 1e9), 'acted after the end');
  duelForfeit(d, 'ann', now + 5);
  duelForfeit(d, 'bao', now + 5);
  check(JSON.stringify(d) === done, 'the finished duel changed');
  check(duelView(d, now).winner === d.winner, 'the view hides the winner');
  stats.duels++;
}

test(`duel: ${RUNS} random duels hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = { duels: 0, steps: 0, refused: 0, rounds: 0, wonOnHearts: 0, forfeits: 0, draws: 0, wonOnPoints: 0, timeouts: 0, maxRound: 0 };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playDuel(seed, stats, trace);
    } catch (e) {
      throw new Error(`duel sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast actions:\n${trace.join('\n')}`);
    }
  }
  console.log(`duel sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.duels).toBe(RUNS);
  if (RUNS >= 500) expect(Math.min(stats.wonOnHearts, stats.forfeits, stats.draws, stats.wonOnPoints, stats.timeouts, stats.refused)).toBeGreaterThan(0);
});
