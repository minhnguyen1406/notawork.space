// Randomised simulation of Werewolf: thousands of whole games through the rule functions, mixing
// sensible play with illegal, out-of-turn and garbage input, checked after every step against an
// independent restatement of the rules. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/werewolf.sim.test.ts
import { expect, test, vi } from 'vitest';
import {
  FORCE_AFTER_MS,
  ROLE_LABEL,
  WOLF_MAX,
  WOLF_MIN,
  newWolf,
  rolesFor,
  wolfForce,
  wolfLeave,
  wolfNight,
  wolfStart,
  wolfVote,
  type Role,
  type WolfGame,
} from '../../shared/werewolf';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 2500;
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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- the per-player view, rebuilt from worker/src/tables.ts (wolfView) so we can check what it shows

function viewOf(g: WolfGame, viewer: string, now: number) {
  const me = g.players.find((p) => p.id === viewer);
  const name = (id: string) => (id === 'skip' ? 'nobody' : (g.players.find((p) => p.id === id)?.name ?? '?'));
  const over = g.phase === 'over';
  const iAmWolf = me?.role === 'werewolf';
  const knows = (p: { id: string; alive: boolean; role: string }) =>
    p.id === viewer || !p.alive || over || (me && !me.alive) || (iAmWolf && p.role === 'werewolf');
  let can: 'kill' | 'look' | 'protect' | null = null;
  let done = false;
  if (g.phase === 'night' && me?.alive) {
    if (me.role === 'werewolf') (can = 'kill'), (done = !!g.kills[me.id]);
    else if (me.role === 'seer') (can = 'look'), (done = g.inspected);
    else if (me.role === 'doctor') (can = 'protect'), (done = g.protect !== null);
  }
  return {
    phase: g.phase,
    round: g.round,
    players: g.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, role: knows(p) ? p.role : null })),
    you: viewer,
    yourRole: me?.role ?? null,
    alive: !!me?.alive,
    night: {
      can,
      done,
      picks: iAmWolf && g.phase === 'night' ? Object.entries(g.kills).map(([by, t]) => ({ by: name(by), target: name(t) })) : [],
    },
    notes: me?.role === 'seer' ? g.notes : [],
    votes: g.phase === 'day' ? Object.entries(g.votes).map(([by, t]) => ({ by: name(by), target: name(t) })) : [],
    myVote: g.votes[viewer] ?? null,
    log: g.log.slice(-8),
    winner: g.winner,
    forceIn: g.phase === 'night' || g.phase === 'day' ? Math.max(0, g.since + FORCE_AFTER_MS - now) : 0,
  };
}

// ---- an independent restatement of the rules, used to predict every step

type Action =
  | { k: 'night'; pid: string; target: string }
  | { k: 'vote'; pid: string; target: string }
  | { k: 'force'; pid: string }
  | { k: 'leave'; pid: string };

const livingOf = (g: WolfGame) => g.players.filter((p) => p.alive);
const wolvesOf = (g: WolfGame) => livingOf(g).filter((p) => p.role === 'werewolf');
const isPlaying = (g: WolfGame) => g.phase === 'night' || g.phase === 'day';

/** Who the night is still waiting for. */
function waitingAtNight(g: WolfGame): string[] {
  const out: string[] = [];
  for (const p of livingOf(g)) {
    if (p.role === 'werewolf' && !g.kills[p.id]) out.push(p.id);
    if (p.role === 'seer' && !g.inspected) out.push(p.id);
    if (p.role === 'doctor' && g.protect === null) out.push(p.id);
  }
  return out;
}

function expectedWinner(g: WolfGame): 'village' | 'werewolves' | null {
  const wolves = wolvesOf(g).length;
  const others = livingOf(g).length - wolves;
  return wolves === 0 ? 'village' : wolves >= others ? 'werewolves' : null;
}

function topOf(choices: string[]): string[] {
  const tally = new Map<string, number>();
  for (const c of choices) tally.set(c, (tally.get(c) ?? 0) + 1);
  const top = Math.max(0, ...tally.values());
  return [...tally].filter(([, n]) => n === top).map(([id]) => id);
}

/**
 * Apply `a` to `m` (a copy of the state before) the way the rules say, using `post` only to learn
 * which of several equally-picked victims the random tie-break chose. Returns the expected return value.
 */
function model(m: WolfGame, a: Action, now: number, post: WolfGame): boolean {
  const me = m.players.find((p) => p.id === a.pid);
  const kill = (id: string) => {
    m.players.find((p) => p.id === id)!.alive = false;
  };
  const win = () => {
    const w = expectedWinner(m);
    if (!w) return false;
    m.winner = w;
    m.phase = 'over';
    return true;
  };
  const endNight = () => {
    const cands = topOf(Object.values(m.kills));
    const died = m.players.filter((p) => p.alive && !post.players.find((q) => q.id === p.id)!.alive).map((p) => p.id);
    check(died.length <= 1, `more than one death in a night: ${died}`);
    if (died.length === 1) {
      check(cands.includes(died[0]), `${died[0]} died but was not the werewolves' top pick (${cands})`);
      check(died[0] !== m.protect, `${died[0]} died although the doctor protected them`);
      kill(died[0]);
    } else if (cands.length > 0) {
      check(m.protect !== null && cands.includes(m.protect), `the werewolves picked ${cands} but nobody died and none was protected`);
    }
    if (win()) return;
    m.phase = 'day';
    m.votes = {};
    m.since = now;
  };
  const endDay = () => {
    const top = topOf(Object.values(m.votes));
    if (top.length === 1 && top[0] !== 'skip') kill(top[0]);
    if (win()) return;
    m.phase = 'night';
    m.round++;
    m.kills = {};
    m.protect = null;
    m.inspected = false;
    m.votes = {};
    m.since = now;
  };
  const moveOn = () => {
    if (m.phase === 'night' && waitingAtNight(m).length === 0) endNight();
    else if (m.phase === 'day' && livingOf(m).every((p) => m.votes[p.id])) endDay();
  };

  if (a.k === 'night') {
    const target = m.players.find((p) => p.id === a.target);
    if (m.phase !== 'night' || !me?.alive || !target?.alive) return false;
    if (me.role === 'werewolf') {
      if (target.role === 'werewolf') return false;
      m.kills[me.id] = target.id;
    } else if (me.role === 'seer') {
      if (m.inspected || target.id === me.id) return false;
      m.inspected = true;
      m.notes.push(`Night ${m.round}: ${target.name} is ${target.role === 'werewolf' ? 'a WEREWOLF' : 'not a werewolf'}.`);
    } else if (me.role === 'doctor') {
      if (m.protect !== null) return false;
      m.protect = target.id;
    } else return false;
    moveOn();
    return true;
  }
  if (a.k === 'vote') {
    if (m.phase !== 'day' || !me?.alive) return false;
    if (a.target !== 'skip') {
      const target = m.players.find((p) => p.id === a.target);
      if (!target?.alive || target.id === me.id) return false;
    }
    m.votes[me.id] = a.target;
    moveOn();
    return true;
  }
  if (a.k === 'force') {
    if (!isPlaying(m) || !me?.alive || !(now - m.since >= FORCE_AFTER_MS)) return false;
    if (m.phase === 'night') endNight();
    else endDay();
    return true;
  }
  // leave: out of the game, and none of their choices (or choices aimed at them) count any more
  if (!isPlaying(m) || !me?.alive) return false;
  me.alive = false;
  delete m.kills[me.id];
  delete m.votes[me.id];
  for (const [k, v] of Object.entries(m.kills)) if (v === me.id) delete m.kills[k];
  for (const [k, v] of Object.entries(m.votes)) if (v === me.id) delete m.votes[k];
  if (m.protect === me.id || me.role === 'doctor') m.protect = null;
  if (win()) return true;
  moveOn();
  return true;
}

// ---- invariants that must hold after every step

function invariants(g: WolfGame, now: number, rnd: () => number) {
  const alive = new Set(livingOf(g).map((p) => p.id));
  const role = (id: string) => g.players.find((p) => p.id === id)?.role;

  if (isPlaying(g)) {
    check(g.winner === null && expectedWinner(g) === null, 'the game goes on although one side has already won');
  } else if (g.phase === 'over') {
    check(g.winner !== null && g.winner === expectedWinner(g), `winner is ${g.winner} but the rule says ${expectedWinner(g)}`);
  }
  // Only the living have a say, and only about the living.
  // (Last night's picks stay in the state during the day, unused and unseen, until the next night clears them.)
  for (const [by, t] of g.phase === 'night' ? Object.entries(g.kills) : []) {
    check(alive.has(by) && role(by) === 'werewolf', `kill pick from ${by}, who is not a living werewolf`);
    check(alive.has(t) && role(t) !== 'werewolf', `kill pick aimed at ${t}, who is not a living non-wolf`);
  }
  for (const [by, t] of g.phase === 'day' ? Object.entries(g.votes) : []) {
    check(alive.has(by), `vote from ${by}, who is not alive`);
    check(t === 'skip' || (alive.has(t) && t !== by), `vote for ${t} by ${by} is not allowed`);
  }
  if (g.phase === 'night' && g.protect !== null) {
    check(alive.has(g.protect), `protection on ${g.protect}, who is not alive`);
    check(livingOf(g).some((p) => p.role === 'doctor'), 'protection stands although no doctor is alive');
  }
  // Someone living is always being waited for; otherwise the phase would have moved on.
  if (g.phase === 'night') check(waitingAtNight(g).length > 0, 'night is waiting for nobody');
  if (g.phase === 'day') check(livingOf(g).some((p) => !g.votes[p.id]), 'day is waiting for nobody');
  if (g.phase !== 'day') check(Object.keys(g.votes).length === 0 || g.phase === 'over', 'votes left over at night');
  // The public log never names a living player's role, and never carries the seer's findings.
  for (const line of g.log) check(!line.includes('WEREWOLF'), 'a seer note reached the public log');

  // What each person is shown.
  const outsider = 'someone-watching';
  for (const viewer of [...g.players.map((p) => p.id), outsider]) {
    const me = g.players.find((p) => p.id === viewer);
    const v = viewOf(g, viewer, now);
    const ghost = !!me && !me.alive;
    if (g.phase !== 'over' && !ghost) {
      for (const p of v.players) {
        const real = g.players.find((q) => q.id === p.id)!;
        if (p.id === viewer || !real.alive) continue;
        const packMate = me?.role === 'werewolf' && real.role === 'werewolf';
        check(packMate ? p.role === 'werewolf' : p.role === null, `${viewer} is shown the role of living ${p.id}`);
      }
    }
    if (me?.role !== 'werewolf') check(v.night.picks.length === 0, `${viewer} is shown the werewolves' picks`);
    if (me?.role !== 'seer') check(v.notes.length === 0, `${viewer} is shown the seer's notes`);
    if (g.phase !== 'day') check(v.votes.length === 0, 'votes shown outside the day');
  }

  // Non-interference: swapping the roles of two other living players (not across the wolf line for a
  // werewolf viewer) must not change a single byte of what a living player or a watcher is shown.
  if (g.phase !== 'over') {
    const viewers = [...livingOf(g).map((p) => p.id), outsider];
    const viewer = viewers[Math.floor(rnd() * viewers.length)];
    const me = g.players.find((p) => p.id === viewer);
    const others = livingOf(g).filter((p) => p.id !== viewer && !(me?.role === 'werewolf' && p.role === 'werewolf'));
    if (others.length >= 2) {
      const x = others[Math.floor(rnd() * others.length)];
      const y = others[Math.floor(rnd() * others.length)];
      if (x.role !== y.role) {
        const twin = structuredClone(g);
        const tx = twin.players.find((p) => p.id === x.id)!;
        const ty = twin.players.find((p) => p.id === y.id)!;
        [tx.role, ty.role] = [ty.role, tx.role];
        check(
          same(viewOf(g, viewer, now), viewOf(twin, viewer, now)),
          `${viewer}'s view depends on the hidden roles of ${x.id} and ${y.id}`,
        );
      }
    }
  }
}

// ---- one whole game

interface Stats {
  games: number;
  steps: number;
  rejected: number;
  forced: number;
  leaves: number;
  village: number;
  werewolves: number;
  byLeaving: number;
  maxRound: number;
}

const GARBAGE: unknown[] = ['', 'skip', 'nobody', '__proto__', 'constructor', 'toString', NaN, -1, 1e308, null, undefined, {}, [], 0, true];

function playGame(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  vi.spyOn(Math, 'random').mockImplementation(rnd);

  const n = WOLF_MIN + int(WOLF_MAX - WOLF_MIN + 1);
  const people = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player${i}` }));
  const g = newWolf();
  let now = 1_700_000_000_000 + int(1e9);

  // Nothing works before the game starts, and the wrong number of players cannot start one.
  const fresh = JSON.stringify(g);
  check(!wolfNight(g, 'p0', 'p1', now) && !wolfVote(g, 'p0', 'p1', now) && !wolfForce(g, 'p0', now + 1e9), 'acted in the lobby');
  wolfLeave(g, 'p0', now);
  check(!wolfStart(g, people.slice(0, int(WOLF_MIN)), now), 'started with too few');
  check(!wolfStart(g, [...people, ...Array.from({ length: 13 - n + int(3) }, (_, i) => ({ id: `x${i}`, name: `X${i}` }))], now), 'started with too many');
  check(JSON.stringify(g) === fresh, 'the lobby state changed');

  check(wolfStart(g, people, now), 'could not start');
  check(same(g.players.map((p) => p.role).sort(), rolesFor(n).sort()), 'roles dealt do not match rolesFor(n)');
  check(phaseOf(g) === 'night' && g.round === 1 && g.players.every((p) => p.alive) && g.since === now, 'bad opening state');
  const counts = (r: Role) => rolesFor(n).filter((x) => x === r).length;
  check(counts('seer') === 1 && counts('doctor') === 1 && counts('werewolf') === (n >= 12 ? 3 : n >= 8 ? 2 : 1), 'rolesFor is off');
  invariants(g, now, rnd);

  /** How this table behaves: mostly sensible, sometimes sleepy (lots of forcing) or chaotic. */
  const mood = pick(['sensible', 'sensible', 'sleepy', 'chaotic', 'leavers'] as const);
  const anyone = () => {
    const r = rnd();
    if (r < 0.75) return pick(g.players).id;
    if (r < 0.85) return 'stranger';
    return pick(GARBAGE) as string;
  };

  for (let step = 0; phaseOf(g) !== 'over'; step++) {
    check(step < 20_000, 'the game did not end');
    stats.steps++;
    // Time passes: usually a little, sometimes a jump past the wait, occasionally none at all.
    const tr = rnd();
    now += tr < 0.1 ? 0 : tr < (mood === 'sleepy' ? 0.6 : 0.93) ? int(4000) : tr < 0.99 ? FORCE_AFTER_MS + int(60_000) : int(1e10);

    let a: Action;
    const r = rnd();
    const sensible = mood === 'chaotic' ? 0.3 : mood === 'sleepy' ? 0.35 : 0.65;
    const alive = livingOf(g);
    if (r < sensible) {
      if (g.phase === 'night') {
        const pid = pick(waitingAtNight(g));
        const me = g.players.find((p) => p.id === pid)!;
        const targets = alive.filter((p) => (me.role === 'werewolf' ? p.role !== 'werewolf' : me.role === 'seer' ? p.id !== pid : true));
        a = { k: 'night', pid, target: pick(targets).id };
      } else {
        const waiting = alive.filter((p) => !g.votes[p.id]);
        const me = rnd() < 0.85 ? pick(waiting) : pick(alive); // sometimes someone changes their mind
        const targets = alive.filter((p) => p.id !== me.id && !(me.role === 'werewolf' && p.role === 'werewolf'));
        // Most villages agree on somebody now and then, which is what actually ends games.
        const agreed = alive[(g.round + seed) % alive.length];
        a = { k: 'vote', pid: me.id, target: rnd() < 0.15 ? 'skip' : rnd() < 0.5 && agreed.id !== me.id ? agreed.id : pick(targets).id };
      }
    } else if (r < sensible + (mood === 'leavers' ? 0.12 : 0.02)) {
      a = { k: 'leave', pid: anyone() };
    } else if (r < sensible + 0.2) {
      a = { k: 'force', pid: anyone() };
    } else {
      // Anything goes: wrong phase, the dead, strangers, werewolves eating each other, garbage.
      const target = rnd() < 0.7 ? pick([...g.players.map((p) => p.id), 'skip']) : (pick(GARBAGE) as string);
      a = { k: rnd() < 0.5 ? 'night' : 'vote', pid: anyone(), target };
    }
    trace.push(`${step}:${g.phase}${g.round} t+${now - g.since} ${JSON.stringify(a)}`);
    if (trace.length > 12) trace.shift();

    const before = structuredClone(g);
    // Now and then the clock handed to a force is broken; that must never move the game on.
    const at = a.k === 'force' && rnd() < 0.05 ? pick([NaN, -Infinity, -1, now - 1e12]) : now;
    let ret: boolean;
    if (a.k === 'night') ret = wolfNight(g, a.pid, a.target, now);
    else if (a.k === 'vote') ret = wolfVote(g, a.pid, a.target, now);
    else if (a.k === 'force') ret = wolfForce(g, a.pid, at);
    else {
      wolfLeave(g, a.pid, now);
      ret = JSON.stringify(g) !== JSON.stringify(before);
    }

    // Forcing only ever works after the wait.
    if (a.k === 'force' && ret) {
      check(at === now && now - before.since >= FORCE_AFTER_MS, 'forced before the wait was up');
      stats.forced++;
    }
    const m = structuredClone(before);
    const want = model(m, a, at, g);
    check(ret === want, `returned ${ret} but the rules say ${want}`);
    if (!ret) {
      check(same(g, before), 'a refused action changed the state');
      stats.rejected++;
    } else {
      const { log: gotLog, ...got } = g;
      const { log: _modelLog, ...exp } = m;
      check(same(got, exp), `state differs from the rules:\n got ${JSON.stringify(got)}\n exp ${JSON.stringify(exp)}`);
      // The log only grows, and announces every death with the right role.
      check(same(gotLog.slice(0, before.log.length), before.log), 'the log was rewritten');
      if (g.phase !== before.phase) check(gotLog.length > before.log.length, 'a change of phase was not announced');
      const news = gotLog.slice(before.log.length).join(' ');
      for (const p of before.players) {
        if (p.alive && !g.players.find((q) => q.id === p.id)!.alive) {
          check(news.includes(p.name) && news.includes(`They were ${ROLE_LABEL[p.role]}.`), `the death of ${p.id} was not announced correctly`);
        }
      }
      if (a.k === 'leave') stats.leaves++;
    }
    // Roles and seats never change.
    check(same(g.players.map((p) => [p.id, p.name, p.role]), before.players.map((p) => [p.id, p.name, p.role])), 'players or roles changed');
    for (const p of before.players) check(p.alive || !g.players.find((q) => q.id === p.id)!.alive, `${p.id} came back to life`);
    invariants(g, now, rnd);
    stats.maxRound = Math.max(stats.maxRound, g.round);
    if (phaseOf(g) === 'over' && a.k === 'leave') stats.byLeaving++;
  }

  // Once it is over nothing more can happen, until someone starts a new game.
  check(g.winner !== null, 'over without a winner');
  stats[g.winner]++;
  const done = JSON.stringify(g);
  for (let i = 0; i < 6; i++) {
    const pid = pick(g.players).id;
    const t = pick([...g.players.map((p) => p.id), 'skip']);
    check(!wolfNight(g, pid, t, now) && !wolfVote(g, pid, t, now) && !wolfForce(g, pid, now + 1e9), 'acted after the end');
    wolfLeave(g, pid, now);
  }
  check(JSON.stringify(g) === done, 'the finished game changed');
  if (rnd() < 0.2) {
    check(wolfStart(g, people.slice(0, WOLF_MIN), now + 5), 'could not start a new game after the last');
    check(g.round === 1 && g.phase === 'night' && g.notes.length === 0 && g.winner === null && g.players.length === WOLF_MIN, 'new game kept old state');
    check(g.protect === null && !g.inspected && same(g.kills, {}) && same(g.votes, {}) && g.log.length === 1, 'new game kept old choices');
    check(!wolfStart(g, people, now + 6), 'restarted a running game');
  }
  stats.games++;
}

test(`werewolf: ${RUNS} random games hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = { games: 0, steps: 0, rejected: 0, forced: 0, leaves: 0, village: 0, werewolves: 0, byLeaving: 0, maxRound: 0 };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playGame(seed, stats, trace);
    } catch (e) {
      throw new Error(`werewolf sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast actions:\n${trace.join('\n')}`);
    } finally {
      vi.restoreAllMocks();
    }
  }
  console.log(`werewolf sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.games).toBe(RUNS);
  if (RUNS >= 200) expect(Math.min(stats.village, stats.werewolves, stats.forced, stats.leaves, stats.rejected)).toBeGreaterThan(0);
});
