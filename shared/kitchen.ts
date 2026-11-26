// Kitchen rules. Pure functions over a plain state object; the server runs them,
// and the browser only draws the result. Nothing here is timed against the player:
// food never burns and there are no orders to miss.
import type { Station } from './layout';

export type IngType = 'tomato' | 'lettuce' | 'bun' | 'cheese' | 'patty' | 'egg';
export type IngState = 'raw' | 'chopped' | 'cooked';

export type Item =
  | { k: 'ing'; type: IngType; st: IngState; prog?: number; doneAt?: number }
  | { k: 'plate'; c: IngType[] };

export interface KitchenState {
  /** What is sitting on each counter, board or stove. */
  slots: Record<string, Item | null>;
  /** What each player is carrying. */
  held: Record<string, Item | null>;
  /** The most recent dishes, shown on the dining table. */
  served: IngType[][];
  total: number;
  /** Server clock when this state was sent, so browsers can line up cooking timers. */
  now: number;
}

export const CHOPPABLE: IngType[] = ['tomato', 'lettuce'];
export const COOKABLE: IngType[] = ['patty', 'egg'];
export const COOK_MS = 6000;
export const CHOPS_NEEDED = 4;
export const MAX_ON_PLATE = 5;
export const TABLE_DISHES = 6;

export const ING_LABEL: Record<IngType, string> = {
  tomato: 'tomato',
  lettuce: 'lettuce',
  bun: 'bun',
  cheese: 'cheese',
  patty: 'patty',
  egg: 'egg',
};

export const RECIPES: { name: string; items: IngType[] }[] = [
  { name: 'Garden Salad', items: ['lettuce', 'tomato'] },
  { name: 'Grilled Cheese', items: ['bun', 'cheese'] },
  { name: 'Egg Sandwich', items: ['bun', 'egg'] },
  { name: 'Breakfast Plate', items: ['egg', 'tomato'] },
  { name: 'Burger', items: ['bun', 'patty', 'lettuce'] },
  { name: 'Cheeseburger', items: ['bun', 'patty', 'cheese'] },
  { name: 'The Works', items: ['bun', 'patty', 'cheese', 'lettuce', 'tomato'] },
];

const key = (items: IngType[]) => [...items].sort().join('+');
const RECIPE_BY_KEY = new Map(RECIPES.map((r) => [key(r.items), r.name]));

export const dishName = (items: IngType[]) => RECIPE_BY_KEY.get(key(items)) ?? 'Mystery Plate';

/** The state an ingredient must be in before it can go on a plate. */
export const plateState = (type: IngType): IngState =>
  CHOPPABLE.includes(type) ? 'chopped' : COOKABLE.includes(type) ? 'cooked' : 'raw';

const platable = (item: Item) => item.k === 'ing' && item.st === plateState(item.type);

/** Finish cooking if the timer has run out. */
export function settle(item: Item | null, now: number) {
  if (item && item.k === 'ing' && item.doneAt !== undefined && now >= item.doneAt) {
    item.st = 'cooked';
    delete item.doneAt;
  }
}

export const newKitchen = (): KitchenState => ({ slots: {}, held: {}, served: [], total: 0, now: 0 });

export interface UseResult {
  changed: boolean;
  served?: string;
}

/** The main "E" action: take, put down, combine or serve, depending on the station. */
export function useStation(s: KitchenState, pid: string, st: Station, now: number): UseResult {
  const held = s.held[pid] ?? null;
  const ok: UseResult = { changed: true };
  const no: UseResult = { changed: false };

  switch (st.type) {
    case 'crate':
      if (!st.ing || !Object.hasOwn(ING_LABEL, st.ing)) return no; // not a real crate
      if (!held) {
        s.held[pid] = { k: 'ing', type: st.ing!, st: 'raw' };
        return ok;
      }
      // Put an untouched ingredient back.
      if (held.k === 'ing' && held.type === st.ing && held.st === 'raw' && !held.prog) {
        s.held[pid] = null;
        return ok;
      }
      return no;

    case 'plates':
      if (!held) {
        s.held[pid] = { k: 'plate', c: [] };
        return ok;
      }
      if (held.k === 'plate' && held.c.length === 0) {
        s.held[pid] = null;
        return ok;
      }
      return no;

    case 'bin':
      if (!held) return no;
      // Binning a full plate scrapes it clean; binning anything else throws it away.
      s.held[pid] = held.k === 'plate' && held.c.length > 0 ? { k: 'plate', c: [] } : null;
      return ok;

    case 'hatch': {
      if (!held || held.k !== 'plate' || held.c.length === 0) return no;
      const name = dishName(held.c);
      s.served.push(held.c);
      if (s.served.length > TABLE_DISHES) s.served.shift();
      s.total++;
      s.held[pid] = null;
      return { changed: true, served: name };
    }

    case 'counter':
    case 'board':
    case 'stove': {
      // one item each
      const slot = s.slots[st.id] ?? null;
      settle(slot, now);

      if (held && !slot) {
        if (st.type === 'stove') {
          if (!(held.k === 'ing' && COOKABLE.includes(held.type) && held.st === 'raw')) return no;
          s.slots[st.id] = { ...held, doneAt: now + COOK_MS };
        } else {
          s.slots[st.id] = held;
        }
        s.held[pid] = null;
        return ok;
      }
      if (!held && slot) {
        if (slot.k === 'ing') delete slot.doneAt; // taken off the heat early: stays raw
        s.held[pid] = slot;
        s.slots[st.id] = null;
        return ok;
      }
      if (held && slot) {
        if (held.k === 'plate' && slot.k === 'ing' && platable(slot) && held.c.length < MAX_ON_PLATE) {
          held.c.push(slot.type);
          s.slots[st.id] = null;
          return ok;
        }
        if (held.k === 'ing' && slot.k === 'plate' && platable(held) && slot.c.length < MAX_ON_PLATE) {
          slot.c.push(held.type);
          s.held[pid] = null;
          return ok;
        }
      }
      return no;
    }

    default:
      return no; // not a kind of station this kitchen has
  }
}

/** The "F" action: one chop on whatever is on a board. */
export function actStation(s: KitchenState, st: Station): boolean {
  if (st.type !== 'board') return false;
  const slot = s.slots[st.id];
  if (!slot || slot.k !== 'ing' || slot.st !== 'raw' || !CHOPPABLE.includes(slot.type)) return false;
  slot.prog = (slot.prog ?? 0) + 1 / CHOPS_NEEDED;
  if (slot.prog >= 0.999) {
    slot.st = 'chopped';
    delete slot.prog;
  }
  return true;
}

/**
 * Someone left the room. Whatever they were carrying goes with them: crates and the plate stack
 * never run out, so nothing needs to be handed back. Returns true if they were holding something.
 */
export function kitchenLeave(s: KitchenState, pid: string): boolean {
  const had = !!s.held[pid];
  delete s.held[pid];
  return had;
}
