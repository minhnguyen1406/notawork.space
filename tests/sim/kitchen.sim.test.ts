// Randomised simulation of the kitchen: thousands of cooking sessions through the rule functions,
// mixing cooks who follow recipes with people mashing every station at random, leaving at any
// moment, and the clock jumping about. After every step: nothing is duplicated or lost except by
// serving, binning, putting back or leaving; food only cooks after its time; every dish is named
// correctly whatever order it was built in. A failure prints the seed; replay it with
//   SIM_SEED=<seed> SIM_RUNS=1 npx vitest run tests/sim/kitchen.sim.test.ts
import { expect, test } from 'vitest';
import {
  CHOPPABLE,
  CHOPS_NEEDED,
  COOKABLE,
  COOK_MS,
  ING_LABEL,
  MAX_ON_PLATE,
  RECIPES,
  TABLE_DISHES,
  actStation,
  kitchenLeave,
  newKitchen,
  useStation,
  type IngType,
  type Item,
  type KitchenState,
  type UseResult,
} from '../../shared/kitchen';
import { STATIONS, type Station } from '../../shared/layout';

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

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const TYPES = Object.keys(ING_LABEL) as IngType[];
const SLOT_KINDS = ['counter', 'board', 'stove'];
const station = (id: string) => STATIONS.find((s) => s.id === id)!;
const ready = (type: IngType) => (CHOPPABLE.includes(type) ? 'chopped' : COOKABLE.includes(type) ? 'cooked' : 'raw');
const isReady = (item: Item) => item.k === 'ing' && item.st === ready(item.type);

/** The name a plate should be served under, worked out without the code's own lookup. */
function nameOf(items: IngType[]) {
  const want = [...items].sort().join();
  return RECIPES.find((r) => [...r.items].sort().join() === want)?.name ?? 'Mystery Plate';
}

/** Everything in the kitchen, counted: ingredients by type (loose or on a plate) and plates. */
function stock(s: KitchenState) {
  const count: Record<string, number> = { plate: 0 };
  for (const t of TYPES) count[t] = 0;
  for (const item of [...Object.values(s.slots), ...Object.values(s.held)]) {
    if (!item) continue;
    if (item.k === 'plate') {
      count.plate++;
      for (const t of item.c) count[t]++;
    } else count[item.type]++;
  }
  return count;
}
const stockOfItem = (item: Item | null) => stock({ slots: {}, held: { x: item }, served: [], total: 0, now: 0 });

// ---- an independent restatement of the rules

function model(m: KitchenState, pid: string, st: Station, now: number): UseResult {
  const held = m.held[pid] ?? null;
  const no = { changed: false };
  const yes = { changed: true };
  if (st.type === 'crate') {
    if (!held) {
      m.held[pid] = { k: 'ing', type: st.ing!, st: 'raw' };
      return yes;
    }
    if (held.k === 'ing' && held.type === st.ing && held.st === 'raw' && held.prog === undefined) {
      m.held[pid] = null;
      return yes;
    }
    return no;
  }
  if (st.type === 'plates') {
    if (!held) m.held[pid] = { k: 'plate', c: [] };
    else if (held.k === 'plate' && held.c.length === 0) m.held[pid] = null;
    else return no;
    return yes;
  }
  if (st.type === 'bin') {
    if (!held) return no;
    m.held[pid] = held.k === 'plate' && held.c.length > 0 ? { k: 'plate', c: [] } : null;
    return yes;
  }
  if (st.type === 'hatch') {
    if (!held || held.k !== 'plate' || held.c.length === 0) return no;
    m.served.push(held.c);
    while (m.served.length > TABLE_DISHES) m.served.shift();
    m.total++;
    m.held[pid] = null;
    return { changed: true, served: nameOf(held.c) };
  }
  if (!SLOT_KINDS.includes(st.type)) return no;

  // A counter, board or stove holds one thing. Food on a stove is cooked once its time is up.
  const slot = m.slots[st.id] ?? null;
  if (slot && slot.k === 'ing' && slot.doneAt !== undefined && now >= slot.doneAt) {
    slot.st = 'cooked';
    delete slot.doneAt;
  }
  if (held && !slot) {
    if (st.type === 'stove') {
      if (held.k !== 'ing' || !COOKABLE.includes(held.type) || held.st !== 'raw') return no;
      m.slots[st.id] = { ...held, doneAt: now + COOK_MS };
    } else m.slots[st.id] = held;
    m.held[pid] = null;
    return yes;
  }
  if (!held && slot) {
    if (slot.k === 'ing') delete slot.doneAt;
    m.held[pid] = slot;
    m.slots[st.id] = null;
    return yes;
  }
  if (held && slot) {
    if (held.k === 'plate' && slot.k === 'ing' && isReady(slot) && held.c.length < MAX_ON_PLATE) {
      held.c.push(slot.type);
      m.slots[st.id] = null;
      return yes;
    }
    if (held.k === 'ing' && slot.k === 'plate' && isReady(held) && slot.c.length < MAX_ON_PLATE) {
      slot.c.push(held.type);
      m.held[pid] = null;
      return yes;
    }
  }
  return no;
}

// ---- invariants that must hold after every step

function invariants(s: KitchenState) {
  const seen = new Set<object>();
  const once = (o: object, what: string) => {
    check(!seen.has(o), `${what} is in two places at once`);
    seen.add(o);
  };
  const look = (item: Item | null | undefined, where: string, onStove: boolean) => {
    if (!item) return;
    once(item, `the thing ${where}`);
    if (item.k === 'plate') {
      once(item.c, `the plate contents ${where}`);
      check(item.c.length <= MAX_ON_PLATE && item.c.every((t) => TYPES.includes(t)), `bad plate ${where}: ${JSON.stringify(item)}`);
      check(!onStove, 'a plate is on a stove');
      return;
    }
    check(item.k === 'ing' && TYPES.includes(item.type), `not a real ingredient ${where}: ${JSON.stringify(item)}`);
    check(item.st === 'raw' || (item.st === 'chopped' && CHOPPABLE.includes(item.type)) || (item.st === 'cooked' && COOKABLE.includes(item.type)), `impossible ${item.st} ${item.type} ${where}`);
    if (item.prog !== undefined) {
      check(item.st === 'raw' && CHOPPABLE.includes(item.type), `chopping progress on a ${item.st} ${item.type}`);
      check([1, 2, 3].some((n) => Math.abs(item.prog! - n / CHOPS_NEEDED) < 1e-9), `chopping progress of ${item.prog}`);
    }
    if (item.doneAt !== undefined) check(onStove && item.st === 'raw' && COOKABLE.includes(item.type), `a cooking timer on something ${where}`);
    if (onStove) check(COOKABLE.includes(item.type), `a ${item.type} is on a stove`);
  };
  for (const [id, item] of Object.entries(s.slots)) {
    const st = station(id);
    check(st && SLOT_KINDS.includes(st.type), `something is stored at ${id}, which holds nothing`);
    look(item, `on ${id}`, st.type === 'stove');
  }
  for (const [pid, item] of Object.entries(s.held)) look(item, `held by ${pid}`, false);
  check(s.served.length <= TABLE_DISHES, 'too many dishes on the table');
  for (const dish of s.served) {
    once(dish, 'a served dish');
    check(dish.length >= 1 && dish.length <= MAX_ON_PLATE && dish.every((t) => TYPES.includes(t)), `bad dish served: ${dish}`);
  }
  check(Number.isInteger(s.total) && s.total >= s.served.length, 'the count of dishes is off');
}

// ---- one whole session

interface Stats {
  sessions: number;
  steps: number;
  refused: number;
  served: number;
  recipes: number;
  mystery: number;
  cooked: number;
  takenOffEarly: number;
  chopped: number;
  binned: number;
  leaves: number;
  leftHolding: number;
}

function playSession(seed: number, stats: Stats, trace: string[]) {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(list: T[]) => list[int(list.length)];
  const s = newKitchen();
  let now = 1_700_000_000_000 + int(1e9);
  let step = 0;
  const note = (line: string) => {
    trace.push(`${step}: ${line}`);
    if (trace.length > 14) trace.shift();
  };

  /** One checked "E" press. */
  const use = (pid: string, st: Station, at = now): UseResult => {
    step++;
    stats.steps++;
    note(`${pid} uses ${st.id} holding ${JSON.stringify(s.held[pid] ?? null)} slot ${JSON.stringify(s.slots[st.id] ?? null)}`);
    const before = structuredClone(s);
    const m = structuredClone(s);
    const stockBefore = stock(s);
    const want = model(m, pid, st, at);
    const got = useStation(s, pid, st, at);
    check(got.changed === want.changed && got.served === want.served, `returned ${JSON.stringify(got)} but the rules say ${JSON.stringify(want)}`);
    check(JSON.stringify(s) === JSON.stringify(m), `state differs from the rules:\n got ${JSON.stringify(s)}\n exp ${JSON.stringify(m)}`);

    // Only the hands of the person acting and the station they touched can change.
    for (const [id, item] of Object.entries(before.slots)) if (id !== st.id) check(JSON.stringify(s.slots[id]) === JSON.stringify(item), `${id} changed although nobody touched it`);
    for (const [who, item] of Object.entries(before.held)) if (who !== pid) check(JSON.stringify(s.held[who]) === JSON.stringify(item), `${who}'s hands changed although they did nothing`);
    if (st.type !== 'hatch' || !got.changed) check(JSON.stringify(s.served) === JSON.stringify(before.served) && s.total === before.total, 'the table changed without a dish being served');

    // Nothing appears or vanishes except at a crate, the plate stack, the bin and the hatch.
    const after = stock(s);
    const held = before.held[pid] ?? null;
    const delta: Record<string, number> = {};
    if (got.changed) {
      if (st.type === 'crate') delta[st.ing!] = held ? -1 : 1;
      else if (st.type === 'plates') delta.plate = held ? -1 : 1;
      else if (st.type === 'bin' || st.type === 'hatch') {
        for (const [k, n] of Object.entries(stockOfItem(held))) delta[k] = -n;
        if (st.type === 'bin' && held!.k === 'plate' && held!.c.length > 0) delta.plate = 0; // scraped, not thrown away
      }
    }
    for (const k of Object.keys(after)) check(after[k] === stockBefore[k] + (delta[k] ?? 0), `${k}: had ${stockBefore[k]}, now ${after[k]}, after ${pid} used ${st.id}`);

    if (!got.changed) {
      stats.refused++;
      // A refused press changes nothing, except that food whose time was up is now marked cooked.
      const settled = structuredClone(before);
      const slot = settled.slots[st.id];
      if (slot && slot.k === 'ing' && slot.doneAt !== undefined && at >= slot.doneAt) {
        slot.st = 'cooked';
        delete slot.doneAt;
      }
      check(JSON.stringify(s) === JSON.stringify(settled), 'a refused press changed the state');
    }

    // Cooking: the timer is set for exactly the cooking time, and food is cooked only once it has run out.
    const slotBefore = before.slots[st.id] ?? null;
    if (st.type === 'stove') {
      const slotNow = s.slots[st.id] ?? null;
      if (got.changed && !slotBefore && slotNow) {
        check(slotNow.k === 'ing' && slotNow.st === 'raw' && Object.is(slotNow.doneAt, at + COOK_MS), 'the cooking timer was set wrong');
      }
      if (slotBefore && slotBefore.k === 'ing' && slotBefore.st === 'raw') {
        const plated = got.changed && held?.k === 'plate'; // it went straight onto a plate, which only takes cooked food
        const where = slotNow ?? s.held[pid];
        const cookedNow = plated || (!!where && where.k === 'ing' && where.st === 'cooked');
        check(cookedNow === at >= slotBefore.doneAt!, `food was ${cookedNow ? 'cooked' : 'left raw'} at ${at - slotBefore.doneAt!} ms past its time`);
        if (cookedNow) stats.cooked++;
        else if (!slotNow) stats.takenOffEarly++;
        if (slotBefore.doneAt === undefined) check(false, 'raw food sat on a stove without a timer');
      }
    }
    // Only ready ingredients ever reach a plate.
    if (got.changed && held && slotBefore) {
      const added = held.k === 'plate' ? slotBefore : held;
      const justCooked = added.k === 'ing' && added.doneAt !== undefined && at >= added.doneAt; // its time was up as it was lifted
      check(added.k === 'ing' && (justCooked ? 'cooked' : added.st) === ready(added.type), `a ${JSON.stringify(added)} went on a plate`);
    }
    if (got.served) {
      stats.served++;
      check(held!.k === 'plate' && got.served === nameOf(held!.c), 'the dish was given the wrong name');
      check(JSON.stringify(s.served[s.served.length - 1]) === JSON.stringify((held as { c: IngType[] }).c) && s.total === before.total + 1, 'the dish did not reach the table');
    }
    if (got.changed && st.type === 'bin') stats.binned++;
    invariants(s);
    return got;
  };

  /** One checked "F" press. */
  const act = (st: Station) => {
    step++;
    stats.steps++;
    note(`chop at ${st.id} slot ${JSON.stringify(s.slots[st.id] ?? null)}`);
    const before = structuredClone(s);
    const slot = before.slots[st.id] ?? null;
    const can = st.type === 'board' && !!slot && slot.k === 'ing' && slot.st === 'raw' && CHOPPABLE.includes(slot.type);
    const got = actStation(s, st);
    check(got === can, `chopping returned ${got} but the rules say ${can}`);
    if (can && slot.k === 'ing') {
      const chops = Math.round((slot.prog ?? 0) * CHOPS_NEEDED) + 1;
      if (chops >= CHOPS_NEEDED) {
        slot.st = 'chopped';
        delete slot.prog;
        stats.chopped++;
      } else slot.prog = chops / CHOPS_NEEDED;
    } else stats.refused++;
    check(JSON.stringify(s) === JSON.stringify(before), `chopping went wrong:\n got ${JSON.stringify(s)}\n exp ${JSON.stringify(before)}`);
    invariants(s);
    return got;
  };

  const leave = (pid: string) => {
    step++;
    stats.steps++;
    note(`${pid} leaves holding ${JSON.stringify(s.held[pid] ?? null)}`);
    const before = structuredClone(s);
    const had = kitchenLeave(s, pid);
    check(had === !!before.held[pid], 'leaving reported the wrong thing');
    check(!(pid in s.held), 'someone who left is still holding something');
    delete before.held[pid];
    check(JSON.stringify(s) === JSON.stringify(before), 'leaving disturbed the rest of the kitchen');
    stats.leaves++;
    if (had) stats.leftHolding++;
    invariants(s);
  };

  const emptyHands = (pid: string) => {
    for (let i = 0; s.held[pid]; i++) {
      check(i < 2, 'the bin could not empty a pair of hands');
      check(use(pid, station('bin')).changed, 'the bin refused something');
    }
  };
  /** A free station of this kind, clearing one out if they are all in use. */
  const free = (pid: string, type: string, not?: Station) => {
    const all = STATIONS.filter((x) => x.type === type && x !== not);
    const empty = all.filter((x) => !s.slots[x.id]);
    if (empty.length) return pick(empty);
    const st = pick(all);
    check(!s.held[pid], 'cannot clear a station with full hands');
    check(use(pid, st).changed, 'could not pick something up with empty hands');
    emptyHands(pid);
    return st;
  };

  /**
   * A cook makes one dish properly, from these ingredients in this order, and serves it. If every board or
   * stove is taken, someone with empty hands (the "clearer") lifts whatever is in the way and bins it.
   */
  const cookDish = (chef: string, items: IngType[]) => {
    const helper = `${chef}-helper`;
    const handed = rnd() < 0.4; // sometimes the plate stays in the chef's hand and a helper lays the food out
    emptyHands(chef);
    emptyHands(helper);
    const table = free(chef, pick(['counter', 'counter', 'board']));
    check(use(chef, station('plates')).changed, 'no plate');
    if (!handed) check(use(chef, table).changed, 'could not put the plate down');
    const runner = handed ? helper : chef;
    for (const type of items) {
      check(use(runner, station(`crate-${type}`)).changed, `no ${type}`);
      if (CHOPPABLE.includes(type)) {
        const board = free(`${runner}-clearer`, 'board', table);
        check(use(runner, board).changed, 'could not put it on the board');
        for (let i = 0; i < CHOPS_NEEDED; i++) {
          if (i > 0 && rnd() < 0.1) {
            // Not ready yet: it will not go on a plate.
            check(use(runner, board).changed, 'could not pick up a half-chopped thing');
            check(!use(runner, station(`crate-${type}`)).changed, 'a half-chopped thing went back in the crate');
            check(use(runner, board).changed, 'could not put it back on the board');
          }
          check(act(board), 'could not chop');
        }
        check(!act(board), 'chopped something already chopped');
        check(use(runner, board).changed, 'could not pick up the chopped thing');
      } else if (COOKABLE.includes(type)) {
        const stove = free(`${runner}-clearer`, 'stove');
        check(use(runner, stove).changed, 'could not put it on the stove');
        if (rnd() < 0.25) {
          // Too soon: it comes off raw and has to start again.
          now += int(COOK_MS);
          check(use(runner, stove).changed && (s.held[runner] as { st: string }).st === 'raw', 'food came off early but not raw');
          check(use(runner, stove).changed, 'could not put it back on the stove');
        }
        now += COOK_MS + (rnd() < 0.3 ? 0 : int(20_000));
        check(use(runner, stove).changed && (s.held[runner] as { st: string }).st === 'cooked', 'food was not cooked after its time');
      }
      if (handed) {
        const spot = free(`${runner}-clearer`, pick(['counter', 'board']));
        check(use(runner, spot).changed, 'could not lay the food out');
        check(use(chef, spot).changed, 'the plate would not take the food');
      } else {
        check(use(runner, table).changed, 'the plate would not take the food');
      }
    }
    if (!handed) check(use(chef, table).changed, 'could not pick the plate up');
    const dish = (s.held[chef] as { c: IngType[] }).c;
    check(JSON.stringify(dish) === JSON.stringify(items), `the plate holds ${dish}, not ${items}`);
    const result = use(chef, station('hatch'));
    const recipe = RECIPES.find((r) => [...r.items].sort().join() === [...items].sort().join());
    check(result.served === (recipe?.name ?? 'Mystery Plate'), `served a "${result.served}" from ${items}`);
    if (recipe) stats.recipes++;
    else stats.mystery++;
  };

  // ---- the session: a crowd pressing things at random, with proper cooks now and then
  const crowd = Array.from({ length: 2 + int(4) }, (_, i) => `p${i}`);
  const rounds = 40 + int(160);
  for (let i = 0; i < rounds; i++) {
    const tr = rnd();
    now += tr < 0.3 ? 0 : tr < 0.8 ? int(1500) : tr < 0.97 ? int(2 * COOK_MS) : int(1e9);
    const r = rnd();
    const pid = rnd() < 0.95 ? pick(crowd) : pick(['', 'stranger', 'p0 ', 'P0']);
    if (r < 0.62) use(pid, pick(STATIONS));
    else if (r < 0.8) act(rnd() < 0.7 ? station(pick(['board1', 'board2'])) : pick(STATIONS));
    else if (r < 0.84) leave(pid);
    else if (r < 0.88) {
      // A clock that is wrong: behind, or not a number. Nothing may cook early because of it.
      use(pid, pick(STATIONS), pick([NaN, now - int(1e6), -1, 0]));
    } else if (r < 0.9) {
      // Things that are not stations at all.
      const fake = pick([
        { id: 'nowhere', type: 'teleporter', x: 0, z: 0 },
        { id: 'crate-gold', type: 'crate', x: 0, z: 0, ing: 'gold' },
        { id: 'crate-none', type: 'crate', x: 0, z: 0 },
        { id: 'counter1', type: 'COUNTER', x: 0, z: 0 },
      ]) as never as Station;
      const before = JSON.stringify(s);
      check(!useStation(s, pid, fake, now).changed && !actStation(s, fake), 'something that is not a station did something');
      check(JSON.stringify(s) === before, 'something that is not a station changed the kitchen');
    } else if (r < 0.94) {
      // A real dish, built in a shuffled order.
      const items = [...pick(RECIPES).items];
      for (let k = items.length - 1; k > 0; k--) {
        const j = int(k + 1);
        [items[k], items[j]] = [items[j], items[k]];
      }
      cookDish(pick(crowd), items);
    } else if (r < 0.96) {
      cookDish(pick(crowd), Array.from({ length: 1 + int(MAX_ON_PLATE) }, () => pick(TYPES)));
    }
  }

  // Nothing is ever stuck: the whole kitchen can be cleared away.
  const cleaner = 'cleaner';
  for (const pid of Object.keys(s.held)) rnd() < 0.5 ? leave(pid) : emptyHands(pid);
  for (const st of STATIONS.filter((x) => SLOT_KINDS.includes(x.type))) {
    if (!s.slots[st.id]) continue;
    check(use(cleaner, st).changed, `could not clear ${st.id}`);
    emptyHands(cleaner);
  }
  const left = stock(s);
  check(Object.values(left).every((n) => n === 0), `the kitchen could not be cleared: ${JSON.stringify(left)}`);
  stats.sessions++;
}

test(`kitchen: ${RUNS} random sessions hold every invariant`, { timeout: 3_600_000 }, () => {
  const stats: Stats = {
    sessions: 0,
    steps: 0,
    refused: 0,
    served: 0,
    recipes: 0,
    mystery: 0,
    cooked: 0,
    takenOffEarly: 0,
    chopped: 0,
    binned: 0,
    leaves: 0,
    leftHolding: 0,
  };
  const t0 = Date.now();
  for (let i = 0; i < RUNS; i++) {
    const seed = SEED + i;
    const trace: string[] = [];
    try {
      playSession(seed, stats, trace);
    } catch (e) {
      throw new Error(`kitchen sim failed with seed=${seed} (replay: SIM_SEED=${seed} SIM_RUNS=1): ${(e as Error).message}\nlast actions:\n${trace.join('\n')}`);
    }
  }
  console.log(`kitchen sim: ${JSON.stringify(stats)} in ${Date.now() - t0} ms (first seed ${SEED})`);
  expect(stats.sessions).toBe(RUNS);
  if (RUNS >= 200) {
    expect(Math.min(stats.served, stats.recipes, stats.mystery, stats.cooked, stats.takenOffEarly, stats.chopped, stats.binned, stats.leftHolding)).toBeGreaterThan(0);
  }
});
