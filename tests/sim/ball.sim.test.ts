// Randomised simulation of the football: thousands of short matches of random kicks (cleaned up
// the way the server cleans them), stepped with all sorts of time steps, good and bad. After every
// step: no NaN or Infinity, the ball is inside the pitch or in a goal mouth, it never gains speed or
// height from nowhere, it always comes to rest, and a goal is reported exactly when it crosses the
// line. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/ball.sim.test.ts
import { expect, test } from 'vitest';
import { BALL_R, CROSSBAR, MAX_KICK, MAX_LIFT, ballMoving, centreBall, stepBall, type BallState } from '../../shared/ball';
import { GOAL_HALF, PITCH } from '../../shared/layout';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 4000;
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

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const GRAVITY = 20; // as in shared/ball.ts
const EPS = 1e-9;
const show = (b: BallState) => JSON.stringify(b);

// The server's cleaning of a kick message (worker/src/index.ts, case 'kick').
const range = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : Math.max(lo, Math.min(hi, 0));
function kick(b: BallState, mvx: unknown, mvz: unknown, mvy: unknown) {
  let vx = range(mvx, -MAX_KICK, MAX_KICK);
  let vz = range(mvz, -MAX_KICK, MAX_KICK);
  const speed = Math.hypot(vx, vz);
  if (speed > MAX_KICK) {
    vx *= MAX_KICK / speed;
    vz *= MAX_KICK / speed;
  }
  b.vx = vx;
  b.vz = vz;
  if (b.y < 0.3) b.vy = range(mvy, 0, MAX_LIFT);
}

const inMouth = (b: BallState) => Math.abs(b.z - PITCH.cz) < GOAL_HALF - BALL_R * 0.5 && b.y < CROSSBAR;
const height = (b: BallState) => b.y + (b.vy * b.vy) / (2 * GRAVITY); // how high the ball could still get
const speedOf = (b: BallState) => Math.hypot(b.vx, b.vz);

/** Checks on a single step from `pre` to `b`. */
function afterStep(pre: BallState, b: BallState, goal: 'west' | 'east' | null) {
  for (const v of Object.values(b)) check(Number.isFinite(v), `not a finite number: ${show(b)}`);
  check(b.y >= 0, `the ball is underground: ${show(b)}`);
  check(b.z >= PITCH.z1 + BALL_R - EPS && b.z <= PITCH.z2 - BALL_R + EPS, `through a side board: ${show(b)}`);
  if (goal) {
    check(goal === 'west' ? b.x < PITCH.x1 - BALL_R : b.x > PITCH.x2 + BALL_R, `a ${goal} goal with the ball at ${show(b)}`);
    check(inMouth(b), `a goal outside the goal mouth: ${show(b)}`);
    check(pre.x >= PITCH.x1 - BALL_R && pre.x <= PITCH.x2 + BALL_R, `a goal reported for a ball that was already in: ${show(pre)}`);
  } else {
    check(b.x >= PITCH.x1 - BALL_R - EPS && b.x <= PITCH.x2 + BALL_R + EPS, `over the goal line with no goal given: ${show(b)}`);
    if (b.x < PITCH.x1 + BALL_R - EPS || b.x > PITCH.x2 - BALL_R + EPS) check(inMouth(b), `through an end board: ${show(b)}`);
  }
  check(speedOf(b) <= speedOf(pre) + EPS, `the ball sped up from ${speedOf(pre)} to ${speedOf(b)}`);
  check(height(b) <= height(pre) + EPS, `the ball gained height from nowhere: ${show(pre)} -> ${show(b)}`);
  if (!ballMoving(b)) check(b.y === 0 && b.vx === 0 && b.vz === 0 && b.vy === 0, `at rest but ${show(b)}`);
}

interface Stats {
  matches: number;
  kicks: number;
  steps: number;
  goals: number;
  overTheBar: number;
  badSteps: number;
  compared: number;
  worstFree: number;
  worstContact: number;
  worstContactFrom: string;
  longestRoll: number;
}

function playMatch(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  const between = (a: number, b: number) => a + rnd() * (b - a);

  let b = centreBall();
  if (rnd() < 0.5) {
    b.x = between(PITCH.x1 + BALL_R, PITCH.x2 - BALL_R);
    b.z = between(PITCH.z1 + BALL_R, PITCH.z2 - BALL_R);
  }
  if (rnd() < 0.15) {
    // Kicks cannot lift the ball over the bar (see the report), so drop some in from above to use that rule too.
    b.y = between(0, 5);
    b.vy = between(-6, 6);
  }
  // 0.05 is the server's step; browsers use their frame time, capped at 0.05. The rest is a clock behaving badly.
  const dtMode = pick([0.05, 0.05, 1 / 60, 1 / 120, 0.01, 0.1, 0.25, 0.5, 2, 'jitter', 'jitter'] as const);
  const nextDt = () => (dtMode === 'jitter' ? (rnd() < 0.8 ? between(0.001, 0.06) : between(0.06, 1.5)) : dtMode);
  const clientLike = rnd() < 0.15; // a browser does not reset on a goal: it holds the ball still and waits to be told

  const kicks = 2 + int(7);
  for (let k = 0; k < kicks; k++) {
    // A kick: usually sensible, sometimes straight at a goal or a corner, sometimes garbage.
    const style = rnd();
    const power = rnd() < 0.3 ? MAX_KICK : between(0, MAX_KICK * 1.5);
    let mvx: unknown;
    let mvz: unknown;
    let mvy: unknown = rnd() < 0.5 ? 0 : between(-2, MAX_LIFT * 1.3);
    if (style < 0.35) {
      const tx = rnd() < 0.5 ? PITCH.x1 - 2 : PITCH.x2 + 2;
      const tz = PITCH.cz + between(-GOAL_HALF - 1, GOAL_HALF + 1);
      const d = Math.hypot(tx - b.x, tz - b.z) || 1;
      mvx = ((tx - b.x) / d) * power;
      mvz = ((tz - b.z) / d) * power;
    } else if (style < 0.9) {
      const angle = between(0, Math.PI * 2);
      mvx = Math.cos(angle) * power;
      mvz = Math.sin(angle) * power;
    } else {
      const junk = [NaN, Infinity, -Infinity, 1e308, -1e308, '12', null, undefined, {}, [], true];
      mvx = pick(junk);
      mvz = rnd() < 0.5 ? pick(junk) : between(-30, 30);
      mvy = pick(junk);
    }
    kick(b, mvx, mvz, mvy);
    stats.kicks++;
    trace.push(`kick ${k}: ${show(b)} dt=${dtMode}`);
    if (trace.length > 10) trace.shift();
    check(speedOf(b) <= MAX_KICK + 1e-6 && (b.y >= 0.3 || (b.vy >= 0 && b.vy <= MAX_LIFT)), `the kick was not cleaned up: ${show(b)}`);

    let elapsed = 0;
    let held = false;
    const rekickAt = rnd() < 0.3 ? between(0, 2) : Infinity; // sometimes the next kick comes while it is still moving
    for (let step = 0; ballMoving(b) && elapsed < rekickAt; step++) {
      check(elapsed < 15 && step < 20_000, `the ball is still moving ${elapsed.toFixed(1)} s after the kick: ${show(b)}`);

      // A time step that makes no sense must be ignored.
      if (rnd() < 0.01) {
        const pre = { ...b };
        const bad = pick([NaN, -1, 0, -Infinity, -1e-9, '0.05', null, undefined]) as number;
        check(stepBall(b, bad) === null && show(b) === show(pre), `a time step of ${bad} moved the ball`);
        stats.badSteps++;
      }
      // The same tenth of a second, in one step and in ten, must end up in much the same place.
      if (!held && rnd() < 0.04) compare(b, stats);

      const pre = { ...b };
      const dt = rnd() < 0.002 ? pick([Infinity, 1e9, 60, 7]) : nextDt();
      const goal = stepBall(b, dt);
      stats.steps++;
      // A step stops at the moment of a goal (and, past the line, every step reports it again), so it uses little time.
      elapsed += goal ? Math.min(dt, 0.05) : Math.min(dt, 60);
      if (held) {
        // The browser is holding the ball in the net; all that matters is that it stays sane and settles.
        for (const v of Object.values(b)) check(Number.isFinite(v), `not a finite number: ${show(b)}`);
        check(b.y >= 0, `the ball is underground: ${show(b)}`);
        b.vx = b.vz = 0;
        continue;
      }
      try {
        afterStep(pre, b, goal);
      } catch (e) {
        throw new Error(`${(e as Error).message} (step of ${dt} from ${show(pre)})`);
      }
      if (pre.y >= CROSSBAR && b.vx * pre.vx < 0 && Math.abs(pre.z - PITCH.cz) < GOAL_HALF - BALL_R) stats.overTheBar++;
      if (goal) {
        stats.goals++;
        if (clientLike) {
          b.vx = b.vz = 0;
          held = true;
        } else {
          b = centreBall(); // the server puts it back on the spot
          check(!ballMoving(b) && stepBall(b, 0.05) === null, 'a ball on the centre spot moved or scored');
        }
      }
    }
    if (!ballMoving(b)) {
      stats.longestRoll = Math.max(stats.longestRoll, elapsed);
      // A ball at rest stays at rest, and reports nothing, however long you wait.
      const rest = show(b);
      check(stepBall(b, nextDt()) === null && stepBall(b, 1e6) === null && show(b) === rest, 'a ball at rest moved or scored');
    }
    if (held) b = centreBall();
  }
  stats.matches++;
}

/** One 100 ms step against ten 10 ms steps from the same start. */
function compare(b: BallState, stats: Stats) {
  const one = { ...b };
  const ten = { ...b };
  const g1 = stepBall(one, 0.1);
  let g10: string | null = null;
  for (let i = 0; i < 10 && !g10; i++) g10 = stepBall(ten, 0.01);
  for (const v of [...Object.values(one), ...Object.values(ten)]) check(Number.isFinite(v), 'not a finite number in the comparison');
  if (g1 || g10) {
    // Whether a ball right on the line is in after exactly this tenth of a second may differ, but it must be about to be.
    const other = g1 ? ten : one;
    const line = (g1 ?? g10) === 'west' ? PITCH.x1 : PITCH.x2;
    check(Math.abs(other.x - line) < 2.5, `one clock gives a goal, the other has the ball at ${show(other)} (from ${show(b)})`);
    return;
  }
  const speed = speedOf(b);
  const reach = speed * 0.1 + BALL_R + 0.05;
  const clearOfBoards =
    b.x - reach > PITCH.x1 + BALL_R && b.x + reach < PITCH.x2 - BALL_R && b.z - reach > PITCH.z1 + BALL_R && b.z + reach < PITCH.z2 - BALL_R;
  const rolling = b.y === 0 && b.vy === 0 && speed > 1.5; // and will not stop within the tenth of a second
  const flying = b.y + Math.min(b.vy, 0) * 0.1 - 0.5 * GRAVITY * 0.01 > 0.3; // and will not land within it
  const off = Math.max(Math.abs(one.x - ten.x), Math.abs(one.z - ten.z), Math.abs(one.y - ten.y));
  stats.compared++;
  if (clearOfBoards && (rolling || flying)) {
    stats.worstFree = Math.max(stats.worstFree, off);
    check(off < 0.08, `free ball: one step and ten steps differ by ${off.toFixed(3)} m (from ${show(b)})`);
  } else {
    // A bounce lands part-way through a step, so the two clocks may disagree by a fraction of a step's travel.
    if (off > stats.worstContact) stats.worstContactFrom = `${show(b)} -> one ${show(one)} / ten ${show(ten)}`;
    stats.worstContact = Math.max(stats.worstContact, off);
    check(off < 1.0, `bouncing ball: one step and ten steps differ by ${off.toFixed(3)} m (from ${show(b)})`);
  }
}

test(`ball: ${RUNS} random matches hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = { matches: 0, kicks: 0, steps: 0, goals: 0, overTheBar: 0, badSteps: 0, compared: 0, worstFree: 0, worstContact: 0, worstContactFrom: '', longestRoll: 0 };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playMatch(seed, stats, trace);
    } catch (e) {
      throw new Error(`ball sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast kicks:\n${trace.join('\n')}`);
    }
  }
  console.log(`ball sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.matches).toBe(RUNS);
  if (RUNS >= 200) expect(Math.min(stats.goals, stats.badSteps, stats.compared)).toBeGreaterThan(0);
});
