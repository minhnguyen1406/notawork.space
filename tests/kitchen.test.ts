import { expect, test } from 'vitest';
import {
  CHOPS_NEEDED,
  COOK_MS,
  MAX_ON_PLATE,
  RECIPES,
  TABLE_DISHES,
  actStation,
  dishName,
  kitchenLeave,
  newKitchen,
  useStation,
  type IngType,
  type KitchenState,
} from '../shared/kitchen';
import { STATIONS, type Station } from '../shared/layout';

const st = (id: string) => STATIONS.find((s) => s.id === id)!;
const use = (s: KitchenState, pid: string, id: string, now = 0) => useStation(s, pid, st(id), now);

/** Carry a ready-to-plate ingredient: chopped or cooked if it needs to be. */
function fetch(s: KitchenState, pid: string, type: IngType, now: number) {
  use(s, pid, `crate-${type}`, now);
  if (type === 'tomato' || type === 'lettuce') {
    use(s, pid, 'board1', now);
    for (let i = 0; i < CHOPS_NEEDED; i++) actStation(s, st('board1'));
    use(s, pid, 'board1', now);
  } else if (type === 'patty' || type === 'egg') {
    use(s, pid, 'stove1', now);
    use(s, pid, 'stove1', now + COOK_MS);
  }
}

/** Build a plate on counter1 from these ingredients in this order, then serve it. */
function cook(s: KitchenState, items: IngType[]) {
  use(s, 'ann', 'plates');
  use(s, 'ann', 'counter1');
  for (const type of items) {
    fetch(s, 'ann', type, 0);
    expect(use(s, 'ann', 'counter1').changed).toBe(true);
  }
  use(s, 'ann', 'counter1');
  return use(s, 'ann', 'hatch');
}

test('crates hand out raw ingredients and take back only untouched ones', () => {
  const s = newKitchen();
  expect(use(s, 'ann', 'crate-tomato').changed).toBe(true);
  expect(s.held.ann).toEqual({ k: 'ing', type: 'tomato', st: 'raw' });
  expect(use(s, 'ann', 'crate-bun').changed).toBe(false); // wrong crate
  expect(use(s, 'ann', 'crate-tomato').changed).toBe(true);
  expect(s.held.ann).toBeNull();

  use(s, 'ann', 'crate-tomato');
  use(s, 'ann', 'board1');
  actStation(s, st('board1'));
  use(s, 'ann', 'board1');
  expect(use(s, 'ann', 'crate-tomato').changed).toBe(false); // half chopped: not going back
});

test('chopping takes four chops, only on a board, only for things that can be chopped', () => {
  const s = newKitchen();
  use(s, 'ann', 'crate-lettuce');
  use(s, 'ann', 'counter1');
  expect(actStation(s, st('counter1'))).toBe(false);
  use(s, 'ann', 'counter1');
  use(s, 'ann', 'board1');
  for (let i = 0; i < CHOPS_NEEDED - 1; i++) expect(actStation(s, st('board1'))).toBe(true);
  expect(s.slots.board1).toMatchObject({ st: 'raw', prog: 0.75 });
  expect(actStation(s, st('board1'))).toBe(true);
  expect(s.slots.board1).toEqual({ k: 'ing', type: 'lettuce', st: 'chopped' });
  expect(actStation(s, st('board1'))).toBe(false); // already chopped

  use(s, 'bao', 'crate-bun');
  use(s, 'bao', 'board2');
  expect(actStation(s, st('board2'))).toBe(false); // a bun is not chopped
});

test('cooking finishes only once its time is up, and coming off early starts again', () => {
  const s = newKitchen();
  use(s, 'ann', 'crate-bun', 0);
  expect(use(s, 'ann', 'stove1', 0).changed).toBe(false); // only things that cook go on the stove
  use(s, 'ann', 'crate-bun', 0);
  use(s, 'ann', 'crate-patty', 0);
  expect(use(s, 'ann', 'stove1', 1000).changed).toBe(true);
  expect(s.slots.stove1).toMatchObject({ st: 'raw', doneAt: 1000 + COOK_MS });
  use(s, 'ann', 'stove1', 1000 + COOK_MS - 1); // taken off a moment too soon
  expect(s.held.ann).toEqual({ k: 'ing', type: 'patty', st: 'raw' });
  use(s, 'ann', 'stove1', 20_000);
  use(s, 'ann', 'stove1', 20_000 + COOK_MS - 1);
  expect(s.held.ann).toMatchObject({ st: 'raw' }); // the earlier time on the heat does not count
  use(s, 'ann', 'stove1', 30_000);
  use(s, 'ann', 'stove1', 30_000 + COOK_MS);
  expect(s.held.ann).toEqual({ k: 'ing', type: 'patty', st: 'cooked' });
  expect(use(s, 'ann', 'stove2', 40_000).changed).toBe(false); // cooked food does not go back on
});

test('only prepared ingredients go on a plate, from either hand, up to five', () => {
  const s = newKitchen();
  use(s, 'ann', 'plates');
  use(s, 'ann', 'counter1');
  use(s, 'ann', 'crate-tomato');
  expect(use(s, 'ann', 'counter1').changed).toBe(false); // raw tomato
  use(s, 'ann', 'crate-tomato');
  use(s, 'ann', 'crate-egg');
  expect(use(s, 'ann', 'counter1').changed).toBe(false); // raw egg
  use(s, 'ann', 'crate-egg');

  // Plate in hand, ingredient on the counter.
  use(s, 'ann', 'crate-bun');
  use(s, 'ann', 'counter2');
  use(s, 'ann', 'counter1');
  expect(use(s, 'ann', 'counter2').changed).toBe(true);
  expect(s.held.ann).toEqual({ k: 'plate', c: ['bun'] });
  expect(s.slots.counter2).toBeNull();

  // Ingredient in hand, plate on the counter.
  use(s, 'ann', 'counter1');
  for (let i = 1; i < MAX_ON_PLATE; i++) {
    use(s, 'ann', 'crate-cheese');
    expect(use(s, 'ann', 'counter1').changed).toBe(true);
  }
  use(s, 'ann', 'crate-cheese');
  expect(use(s, 'ann', 'counter1').changed).toBe(false); // full
  expect(s.slots.counter1).toEqual({ k: 'plate', c: ['bun', 'cheese', 'cheese', 'cheese', 'cheese'] });
});

test('every recipe is recognised whatever order the ingredients went on', () => {
  for (const r of RECIPES) {
    const orders = [r.items, [...r.items].reverse(), [...r.items.slice(1), r.items[0]]];
    for (const order of orders) {
      const s = newKitchen();
      const result = cook(s, order);
      expect(result).toEqual({ changed: true, served: r.name });
      expect(s.total).toBe(1);
      expect(s.held.ann).toBeNull();
      expect([...s.served[0]].sort()).toEqual([...r.items].sort());
    }
  }
  expect(dishName(['bun'])).toBe('Mystery Plate');
  expect(dishName(['bun', 'bun', 'cheese'])).toBe('Mystery Plate'); // a double bun is not a Grilled Cheese
  expect(cook(newKitchen(), ['cheese', 'cheese'])).toEqual({ changed: true, served: 'Mystery Plate' });
});

test('the hatch takes only a plate with food on it, and the table shows the latest six dishes', () => {
  const s = newKitchen();
  expect(use(s, 'ann', 'hatch').changed).toBe(false);
  use(s, 'ann', 'plates');
  expect(use(s, 'ann', 'hatch').changed).toBe(false); // empty plate
  use(s, 'ann', 'plates');
  use(s, 'ann', 'crate-bun');
  expect(use(s, 'ann', 'hatch').changed).toBe(false); // no plate
  use(s, 'ann', 'crate-bun');
  for (let i = 0; i < TABLE_DISHES + 2; i++) cook(s, i % 2 ? ['bun', 'cheese'] : ['cheese']);
  expect(s.total).toBe(TABLE_DISHES + 2);
  expect(s.served).toHaveLength(TABLE_DISHES);
});

test('the bin scrapes a full plate clean and throws anything else away', () => {
  const s = newKitchen();
  expect(use(s, 'ann', 'bin').changed).toBe(false);
  use(s, 'ann', 'plates');
  use(s, 'ann', 'counter1');
  use(s, 'ann', 'crate-bun');
  use(s, 'ann', 'counter1');
  use(s, 'ann', 'counter1');
  expect(use(s, 'ann', 'bin').changed).toBe(true);
  expect(s.held.ann).toEqual({ k: 'plate', c: [] });
  expect(use(s, 'ann', 'bin').changed).toBe(true);
  expect(s.held.ann).toBeNull();
});

test('each thing is in one place: putting down and picking up moves it, never copies it', () => {
  const s = newKitchen();
  use(s, 'ann', 'crate-cheese');
  use(s, 'ann', 'counter1');
  expect(s.held.ann).toBeNull();
  expect(use(s, 'bao', 'counter1').changed).toBe(true);
  expect(s.slots.counter1).toBeNull();
  expect(use(s, 'ann', 'counter1').changed).toBe(false); // already gone
  expect(s.held).toEqual({ ann: null, bao: { k: 'ing', type: 'cheese', st: 'raw' } });
});

test('someone leaving takes what they carried with them and leaves the counters alone', () => {
  const s = newKitchen();
  use(s, 'ann', 'crate-cheese');
  use(s, 'ann', 'counter1');
  use(s, 'ann', 'plates');
  expect(kitchenLeave(s, 'ann')).toBe(true);
  expect('ann' in s.held).toBe(false);
  expect(s.slots.counter1).toEqual({ k: 'ing', type: 'cheese', st: 'raw' });
  expect(kitchenLeave(s, 'ann')).toBe(false);
  expect(kitchenLeave(s, 'nobody')).toBe(false);
});

// ---- regressions found by tests/sim/kitchen.sim.test.ts

test('regression: something that is not one of the kitchen stations does nothing', () => {
  const s = newKitchen();
  use(s, 'ann', 'crate-cheese');
  const before = JSON.stringify(s);
  const fake = { id: 'nowhere', type: 'teleporter', x: 0, z: 0 } as never as Station;
  expect(useStation(s, 'ann', fake, 0).changed).toBe(false); // used to act as a hidden extra counter
  expect(actStation(s, fake)).toBe(false);
  expect(JSON.stringify(s)).toBe(before);

  const emptyCrate = { id: 'crate-x', type: 'crate', x: 0, z: 0 } as Station;
  expect(useStation(s, 'bao', emptyCrate, 0).changed).toBe(false); // used to hand out an ingredient with no type
  expect(useStation(s, 'bao', { ...emptyCrate, ing: 'gold' as never }, 0).changed).toBe(false);
  expect(JSON.stringify(s)).toBe(before);
});
