// Randomised simulation of Phố Lớn: thousands of whole games through the rule functions, mixing
// sensible play with illegal, out-of-turn and garbage input. Every step is checked against an
// independent restatement of the rules that also keeps a ledger of every coin entering or leaving
// the game. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/property.sim.test.ts
import { expect, test, vi } from 'vitest';
import {
  FESTIVAL,
  LUCKY_COUNT,
  MAX_LEVEL,
  PASS_START,
  PHO_MAX,
  PHO_MIN,
  SPACES,
  START_CASH,
  TOLL,
  newPho,
  phoBuild,
  phoBuy,
  phoCurrent,
  phoEnd,
  phoFinish,
  phoLeave,
  phoRoll,
  phoStart,
  type PhoGame,
} from '../../shared/property';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(ENV.SIM_RUNS) || 1500;
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

// ---- an independent restatement of the rules, with a ledger

/** Money that came from the bank, and money that went back to it. */
interface Ledger {
  start: number;
  passStart: number;
  festival: number;
  luckyIn: number;
  sales: number;
  toll: number;
  tax: number;
  luckyOut: number;
  purchases: number;
  buildings: number;
}
type Sink = 'toll' | 'tax' | 'luckyOut';

type Action =
  | { k: 'roll'; pid: string; die?: number; lucky?: number }
  | { k: 'buy'; pid: string; yes: boolean }
  | { k: 'build'; pid: string; space: number }
  | { k: 'end'; pid: string }
  | { k: 'finish'; pid: string }
  | { k: 'leave'; pid: string };

const mPlaying = (m: PhoGame) => m.phase === 'roll' || m.phase === 'buy' || m.phase === 'end';
const citiesOf = (m: PhoGame, pid: string) =>
  SPACES.map((_, i) => i)
    .filter((i) => m.owner[i] === pid)
    .sort((a, b) => SPACES[b].price! - SPACES[a].price!);
const hasPair = (m: PhoGame, pid: string, group: number) => SPACES.every((s, i) => s.group !== group || m.owner[i] === pid);
const worth = (m: PhoGame, pid: string) =>
  m.cash[pid] + citiesOf(m, pid).reduce((sum, i) => sum + SPACES[i].price! + (m.level[i] ?? 0) * (SPACES[i].price! / 2), 0);

function mRent(m: PhoGame, i: number) {
  const base = SPACES[i].price! / 10;
  const level = m.level[i] ?? 0;
  if (level > 0) return base * [1, 3, 6, 10][level];
  return hasPair(m, m.owner[i], SPACES[i].group!) ? base * 2 : base;
}

/** The next player's turn. A jammed player is passed over once, which uses up their jam. */
function mPass(m: PhoGame) {
  for (;;) {
    m.turn = (m.turn + 1) % m.order.length;
    const next = m.order[m.turn];
    if (!m.skip[next]) return;
    m.skip[next] = false;
  }
}

function mRemove(m: PhoGame, pid: string) {
  const i = m.order.indexOf(pid);
  const current = m.order[m.turn];
  for (const c of citiesOf(m, pid)) {
    delete m.owner[c];
    delete m.level[c];
  }
  m.order.splice(i, 1);
  if (m.order.length === 1) {
    m.phase = 'over';
    m.winner = m.order[0];
    m.turn = 0;
    return;
  }
  if (current !== pid) {
    m.turn = m.order.indexOf(current); // someone else left: whoever had the turn keeps it
    return;
  }
  m.phase = 'roll';
  m.die = null;
  m.turn = (i - 1 + m.order.length) % m.order.length;
  mPass(m);
}

function mCharge(m: PhoGame, L: Ledger, pid: string, amount: number, to: string | null, sink: Sink) {
  const mine = citiesOf(m, pid);
  // Buildings go first, at half what they cost; then cities at half price; dearest first.
  for (const i of mine) {
    while (m.cash[pid] < amount && (m.level[i] ?? 0) > 0) {
      m.level[i]--;
      m.cash[pid] += SPACES[i].price! / 4;
      L.sales += SPACES[i].price! / 4;
    }
  }
  for (const i of mine) {
    if (m.cash[pid] >= amount) break;
    delete m.owner[i];
    delete m.level[i];
    m.cash[pid] += SPACES[i].price! / 2;
    L.sales += SPACES[i].price! / 2;
  }
  const paid = Math.min(amount, m.cash[pid]);
  m.cash[pid] -= paid;
  if (to) m.cash[to] += paid;
  else L[sink] += paid;
  if (paid < amount) mRemove(m, pid);
}

/** Apply `a` to the model. Returns what the rule function should return. */
function model(m: PhoGame, L: Ledger, a: Action): boolean {
  const pid = a.pid;
  const mine = mPlaying(m) && m.order[m.turn] === pid;
  switch (a.k) {
    case 'roll': {
      if (m.phase !== 'roll' || !mine) return false;
      const die = a.die!;
      if (!(Number.isInteger(die) && die >= 1 && die <= 6)) return false; // only tests pass a die, but a bad one must be refused
      m.die = die;
      const from = m.pos[pid];
      m.pos[pid] = (from + die) % SPACES.length;
      if (from + die >= SPACES.length) {
        m.cash[pid] += PASS_START;
        L.passStart += PASS_START;
      }
      const i = m.pos[pid];
      const s = SPACES[i];
      if (s.kind === 'city') {
        const owner = m.owner[i];
        if (!owner) {
          if (m.cash[pid] >= s.price!) {
            m.phase = 'buy';
            return true;
          }
        } else if (owner !== pid) mCharge(m, L, pid, mRent(m, i), owner, 'toll');
      } else if (s.kind === 'toll') mCharge(m, L, pid, TOLL, null, 'toll');
      else if (s.kind === 'tax') mCharge(m, L, pid, Math.ceil(m.cash[pid] / 100) * 10, null, 'tax');
      else if (s.kind === 'festival') {
        m.cash[pid] += FESTIVAL;
        L.festival += FESTIVAL;
      } else if (s.kind === 'jam') m.skip[pid] = true;
      else if (s.kind === 'lucky') {
        const gain = (n: number) => {
          m.cash[pid] += n;
          L.luckyIn += n;
        };
        switch (a.lucky) {
          case 0:
            gain(100);
            break;
          case 1:
            gain(150);
            break;
          case 2:
            mCharge(m, L, pid, 80, null, 'luckyOut');
            break;
          case 3:
            mCharge(m, L, pid, 50, null, 'luckyOut');
            break;
          case 4:
            m.pos[pid] = 0;
            gain(PASS_START);
            break;
          case 5:
            for (const other of [...m.order]) if (other !== pid && m.order.includes(other)) mCharge(m, L, other, 25, pid, 'luckyOut');
            break;
          case 6:
            for (const other of [...m.order]) if (other !== pid && m.order.includes(pid)) mCharge(m, L, pid, 25, other, 'luckyOut');
            break;
          default:
            throw new Error(`the simulation drew lucky card ${a.lucky}`);
        }
      }
      if (mPlaying(m) && m.order[m.turn] === pid) m.phase = 'end';
      return true;
    }
    case 'buy': {
      if (m.phase !== 'buy' || !mine) return false;
      if (a.yes === true) {
        const i = m.pos[pid];
        m.cash[pid] -= SPACES[i].price!;
        L.purchases += SPACES[i].price!;
        m.owner[i] = pid;
      }
      m.phase = 'end';
      return true;
    }
    case 'build': {
      const i = a.space;
      if (m.phase !== 'end' || !mine || typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= SPACES.length) return false;
      const s = SPACES[i];
      const cost = (s.price ?? 0) / 2;
      if (s.kind !== 'city' || m.owner[i] !== pid || !hasPair(m, pid, s.group!) || (m.level[i] ?? 0) >= MAX_LEVEL || m.cash[pid] < cost) return false;
      m.cash[pid] -= cost;
      L.buildings += cost;
      m.level[i] = (m.level[i] ?? 0) + 1;
      return true;
    }
    case 'end':
      if (m.phase !== 'end' || !mine) return false;
      m.die = null;
      m.phase = 'roll';
      mPass(m);
      return true;
    case 'finish': {
      if (!mPlaying(m) || !m.order.includes(pid)) return false;
      let best = m.order[0];
      for (const p of m.order) if (worth(m, p) > worth(m, best)) best = p; // ties go to the earlier seat
      m.phase = 'over';
      m.winner = best;
      return true;
    }
    case 'leave':
      if (!mPlaying(m) || !m.order.includes(pid)) return false;
      mRemove(m, pid);
      return true;
  }
}

/** The parts of the state the rules define, in a comparable form. */
function essence(g: PhoGame) {
  const sorted = (o: Record<string | number, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify({
    phase: g.phase,
    order: g.order,
    names: sorted(g.names),
    token: sorted(g.token),
    cash: sorted(g.cash),
    pos: sorted(g.pos),
    owner: sorted(g.owner),
    level: sorted(Object.fromEntries(Object.entries(g.level).filter(([, n]) => n !== 0))),
    jammed: Object.keys(g.skip)
      .filter((p) => g.skip[p])
      .sort(),
    turn: g.turn,
    die: g.die,
    winner: g.winner,
  });
}

// ---- invariants that must hold after every step

function invariants(g: PhoGame, L: Ledger) {
  let total = 0;
  for (const [pid, c] of Object.entries(g.cash)) {
    check(Number.isInteger(c) && c >= 0, `${pid} has ${c} in cash`);
    total += c;
  }
  const expected =
    L.start + L.passStart + L.festival + L.luckyIn + L.sales - L.toll - L.tax - L.luckyOut - L.purchases - L.buildings;
  check(total === expected, `money is not conserved: ${total} in hand, the ledger says ${expected} (${JSON.stringify(L)})`);

  for (const [space, owner] of Object.entries(g.owner)) {
    check(SPACES[+space]?.kind === 'city', `space ${space} is owned but is not a city`);
    check(g.order.includes(owner), `${SPACES[+space].name} is owned by ${owner}, who is not in the game`);
  }
  for (const [space, level] of Object.entries(g.level)) {
    check(Number.isInteger(level) && level >= 0 && level <= MAX_LEVEL, `level ${level} on space ${space}`);
    if (level > 0) {
      const owner = g.owner[+space];
      check(owner !== undefined, `a building stands on unowned space ${space}`);
      check(hasPair(g, owner, SPACES[+space].group!), `a building stands in ${SPACES[+space].name} without the whole pair`);
    }
  }
  for (const pid of g.order) check(Number.isInteger(g.pos[pid]) && g.pos[pid] >= 0 && g.pos[pid] < SPACES.length, `${pid} is at ${g.pos[pid]}`);
  check(new Set(g.order).size === g.order.length, 'someone is in the turn order twice');
  check(g.log.length <= 40, 'the log grew without limit');

  if (mPlaying(g)) {
    check(g.order.length >= 2, 'a game goes on with fewer than two players');
    check(Number.isInteger(g.turn) && g.turn >= 0 && g.turn < g.order.length, `turn ${g.turn} points at nobody`);
    check(g.winner === null, 'a winner was named before the end');
    const cur = phoCurrent(g);
    if (g.phase === 'buy') {
      const s = SPACES[g.pos[cur]];
      check(s.kind === 'city' && g.owner[g.pos[cur]] === undefined && g.cash[cur] >= s.price!, 'offered a city that cannot be bought');
    }
    if (g.phase === 'roll') check(g.die === null, 'a die is showing before the roll');
    else check(Number.isInteger(g.die) && g.die! >= 1 && g.die! <= 6, `the die shows ${g.die}`);
  } else if (g.phase === 'over') {
    check(g.winner !== null && g.order.includes(g.winner), 'the winner is not in the game');
    check(phoCurrent(g) !== undefined, 'the turn points at nobody after the end');
  }
}

// ---- one whole game

interface Stats {
  games: number;
  steps: number;
  rejected: number;
  busts: number;
  leaves: number;
  lastStanding: number;
  finishedEarly: number;
  jams: number;
  everyoneJammed: number;
  builds: number;
  sales: number;
}

const GARBAGE: unknown[] = [NaN, -1, 24, 1e9, 1.5, Infinity, -Infinity, '3', null, undefined, {}, [], true, '__proto__', 'constructor'];

function playGame(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const drawn: number[] = [];
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const v = rnd();
    drawn.push(v);
    return v;
  });
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];

  const n = PHO_MIN + int(PHO_MAX - PHO_MIN + 1);
  const people = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `Player${i}` }));
  const g = newPho();

  // Nothing works in the lobby, and the wrong number of players cannot start.
  const fresh = JSON.stringify(g);
  check(!phoRoll(g, 'p0', 3) && !phoBuy(g, 'p0', true) && !phoBuild(g, 'p0', 1) && !phoEnd(g, 'p0') && !phoFinish(g, 'p0'), 'acted in the lobby');
  phoLeave(g, 'p0');
  check(!phoStart(g, people.slice(0, 1)) && !phoStart(g, []), 'started with too few');
  check(!phoStart(g, Array.from({ length: PHO_MAX + 1 + int(3) }, (_, i) => ({ id: `x${i}`, name: `X${i}` }))), 'started with too many');
  check(JSON.stringify(g) === fresh, 'the lobby state changed');

  check(phoStart(g, people), 'could not start');
  check(phaseOf(g) === 'roll' && g.turn === 0 && g.order.join() === people.map((p) => p.id).join(), 'bad opening state');
  for (const p of people) check(g.cash[p.id] === START_CASH && g.pos[p.id] === 0, 'bad opening cash or position');
  check(!phoStart(g, people), 'restarted a running game');

  // Some tables start poor, so that selling up and going bust happen often; some start rich, so that building does.
  const mode = pick(['normal', 'normal', 'poor', 'broke', 'rich'] as const);
  if (mode !== 'normal') for (const p of people) g.cash[p.id] = mode === 'rich' ? 4000 + int(4000) : mode === 'poor' ? 100 + int(500) : int(120);

  const L: Ledger = { start: 0, passStart: 0, festival: 0, luckyIn: 0, sales: 0, toll: 0, tax: 0, luckyOut: 0, purchases: 0, buildings: 0 };
  L.start = Object.values(g.cash).reduce((a, b) => a + b, 0);
  invariants(g, L);

  const style = pick(['sensible', 'sensible', 'builder', 'chaotic', 'leavers'] as const);
  const maxSteps = 40 + int(style === 'builder' ? 3000 : 900);
  const anyone = () => {
    const r = rnd();
    if (r < 0.55) return pick(people).id; // may have gone bust or left already
    if (r < 0.8) return phoCurrent(g);
    if (r < 0.9) return 'stranger';
    return pick(GARBAGE) as string;
  };

  for (let step = 0; phaseOf(g) !== 'over'; step++) {
    stats.steps++;
    const cur = phoCurrent(g);
    let a: Action;
    const r = rnd();
    const sensible = style === 'chaotic' ? 0.4 : 0.75;
    if (step >= maxSteps) {
      a = { k: 'finish', pid: rnd() < 0.3 ? anyone() : pick(g.order) };
    } else if (r < sensible) {
      if (g.phase === 'roll') {
        // Usually with a chosen die and card (as the unit tests do), sometimes exactly as the server does it.
        a = rnd() < 0.7 ? { k: 'roll', pid: cur, die: 1 + int(6), lucky: int(LUCKY_COUNT) } : { k: 'roll', pid: cur };
      } else if (g.phase === 'buy') {
        a = { k: 'buy', pid: cur, yes: rnd() < 0.85 };
      } else {
        const buildable = citiesOf(g, cur).filter((i) => hasPair(g, cur, SPACES[i].group!) && (g.level[i] ?? 0) < MAX_LEVEL && g.cash[cur] >= SPACES[i].price! / 2);
        a = buildable.length && rnd() < (style === 'builder' ? 0.9 : 0.5) ? { k: 'build', pid: cur, space: pick(buildable) } : { k: 'end', pid: cur };
      }
    } else if (r < sensible + (style === 'leavers' ? 0.03 : 0.004)) {
      a = { k: 'leave', pid: anyone() };
    } else if (r < sensible + 0.035) {
      a = { k: 'finish', pid: rnd() < 0.9 ? 'stranger' : anyone() }; // mostly people who have no say
    } else {
      // Anything goes: out of turn, the wrong phase, people who are not playing, garbage.
      const pid = anyone();
      const kind = int(5);
      if (kind === 0) a = rnd() < 0.5 ? { k: 'roll', pid, die: 1 + int(6), lucky: int(LUCKY_COUNT) } : { k: 'roll', pid, die: pick(GARBAGE.filter((x) => x !== undefined)) as number };
      else if (kind === 1) a = { k: 'buy', pid, yes: rnd() < 0.7 ? rnd() < 0.5 : (pick(GARBAGE) as boolean) };
      else if (kind === 2) a = { k: 'build', pid, space: rnd() < 0.6 ? int(SPACES.length) : (pick(GARBAGE) as number) };
      else if (kind === 3) a = { k: 'end', pid };
      else a = { k: 'build', pid: cur, space: rnd() < 0.5 ? int(SPACES.length) : (pick(GARBAGE) as number) };
    }
    trace.push(`${step}:${g.phase} turn=${cur} ${JSON.stringify(a)}`);
    if (trace.length > 12) trace.shift();

    const before = structuredClone(g);
    const beforeText = JSON.stringify(g);
    drawn.length = 0;
    let ret: boolean;
    if (a.k === 'roll') ret = a.die === undefined ? phoRoll(g, a.pid) : phoRoll(g, a.pid, a.die, a.lucky);
    else if (a.k === 'buy') ret = phoBuy(g, a.pid, a.yes);
    else if (a.k === 'build') ret = phoBuild(g, a.pid, a.space);
    else if (a.k === 'end') ret = phoEnd(g, a.pid);
    else if (a.k === 'finish') ret = phoFinish(g, a.pid);
    else {
      phoLeave(g, a.pid);
      ret = JSON.stringify(g) !== beforeText;
    }
    if (a.k === 'roll' && a.die === undefined && ret) {
      // The server's way: both the die and the card came from Math.random, in that order.
      check(drawn.length >= 1 && drawn.length <= 2, `a roll used ${drawn.length} random numbers`);
      a = { k: 'roll', pid: a.pid, die: 1 + Math.floor(drawn[0] * 6), lucky: drawn.length > 1 ? Math.floor(drawn[1] * LUCKY_COUNT) : undefined };
    } else {
      check(drawn.length === 0, 'something other than an unscripted roll used Math.random');
    }

    const m = structuredClone(before);
    const want = model(m, L, a);
    check(ret === want, `returned ${ret} but the rules say ${want}`);
    if (!ret) {
      check(JSON.stringify(g) === beforeText, 'a refused action changed the state');
      stats.rejected++;
    } else {
      check(essence(g) === essence(m), `state differs from the rules:\n got ${essence(g)}\n exp ${essence(m)}`);
    }
    invariants(g, L);

    // Bookkeeping for the report, and a few direct checks that do not lean on the model.
    const gone = before.order.filter((p) => !g.order.includes(p));
    if (a.k === 'leave' && ret) {
      stats.leaves++;
      check(gone.length === 1 && gone[0] === a.pid, 'leaving removed the wrong people');
      check(g.cash[a.pid] === before.cash[a.pid], 'a leaver took or lost money on the way out');
      check(!Object.values(g.owner).includes(a.pid), 'a leaver still owns a city');
    } else {
      stats.busts += gone.length;
      for (const p of gone) check(g.cash[p] === 0 && !Object.values(g.owner).includes(p), `${p} went bust with something left`);
    }
    if (a.k === 'roll' && ret && SPACES[(before.pos[a.pid] + a.die!) % SPACES.length].kind === 'jam') {
      stats.jams++;
      if (g.order.every((p) => g.skip[p])) stats.everyoneJammed++;
    }
    if (a.k === 'build' && ret) stats.builds++;
    if (phaseOf(g) === 'over') {
      if (a.k === 'finish') stats.finishedEarly++;
      else stats.lastStanding++;
    }
    check(step < maxSteps + 200, 'the game could not be finished');
  }

  // Once it is over nothing more can happen, until a new game is started.
  const done = JSON.stringify(g);
  const w = g.winner!;
  check(!phoRoll(g, w, 2) && !phoBuy(g, w, true) && !phoBuild(g, w, 1) && !phoEnd(g, w) && !phoFinish(g, w), 'acted after the end');
  phoLeave(g, w);
  check(JSON.stringify(g) === done, 'the finished game changed');
  if (rnd() < 0.2) {
    check(phoStart(g, people.slice(0, 2)), 'could not start a new game after the last');
    check(g.order.length === 2 && Object.keys(g.owner).length === 0 && Object.keys(g.cash).length === 2 && g.winner === null && g.turn === 0, 'new game kept old state');
  }
  stats.sales += L.sales;
  stats.games++;
}

test(`Phố Lớn: ${RUNS} random games hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = {
    games: 0,
    steps: 0,
    rejected: 0,
    busts: 0,
    leaves: 0,
    lastStanding: 0,
    finishedEarly: 0,
    jams: 0,
    everyoneJammed: 0,
    builds: 0,
    sales: 0,
  };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playGame(seed, stats, trace);
    } catch (e) {
      throw new Error(`Phố Lớn sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast actions:\n${trace.join('\n')}`);
    } finally {
      vi.restoreAllMocks();
    }
  }
  console.log(`property sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.games).toBe(RUNS);
  if (RUNS >= 200) {
    expect(Math.min(stats.busts, stats.leaves, stats.lastStanding, stats.finishedEarly, stats.jams, stats.everyoneJammed, stats.builds, stats.sales)).toBeGreaterThan(0);
  }
});
