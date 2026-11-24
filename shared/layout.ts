// Where things are in the room. Shared so the server and the browser agree.
// Axes: +x is east, +z is south. An avatar with ry = 0 faces +z.
import type { IngType } from './kitchen';

export const SPAWN = { x: 0, z: 10 };

/** The cinema screen on the north wall. */
export const SCREEN = { x: 0, y: 4.9, z: -19.7, w: 14, h: 7.875 };

export const LOUNGE = { x: -10, z: 7 };
export const DINING = { x: 7, z: 3 };

export type StationType = 'crate' | 'counter' | 'board' | 'stove' | 'plates' | 'bin' | 'hatch';
export interface Station {
  id: string;
  type: StationType;
  x: number;
  z: number;
  ing?: IngType;
}

const ISLAND_X = 14;
const WALL_X = 18.6;

export const STATIONS: Station[] = [
  // The island, north to south.
  { id: 'hatch', type: 'hatch', x: ISLAND_X, z: -4 },
  { id: 'board1', type: 'board', x: ISLAND_X, z: -2 },
  { id: 'board2', type: 'board', x: ISLAND_X, z: 0 },
  { id: 'counter1', type: 'counter', x: ISLAND_X, z: 2 },
  { id: 'counter2', type: 'counter', x: ISLAND_X, z: 4 },
  { id: 'stove1', type: 'stove', x: ISLAND_X, z: 6 },
  { id: 'stove2', type: 'stove', x: ISLAND_X, z: 8 },
  { id: 'plates', type: 'plates', x: ISLAND_X, z: 10 },
  // Along the east wall.
  { id: 'counter3', type: 'counter', x: WALL_X, z: -4 },
  { id: 'crate-tomato', type: 'crate', x: WALL_X, z: -2, ing: 'tomato' },
  { id: 'crate-lettuce', type: 'crate', x: WALL_X, z: 0, ing: 'lettuce' },
  { id: 'crate-bun', type: 'crate', x: WALL_X, z: 2, ing: 'bun' },
  { id: 'crate-cheese', type: 'crate', x: WALL_X, z: 4, ing: 'cheese' },
  { id: 'crate-patty', type: 'crate', x: WALL_X, z: 6, ing: 'patty' },
  { id: 'crate-egg', type: 'crate', x: WALL_X, z: 8, ing: 'egg' },
  { id: 'bin', type: 'bin', x: WALL_X, z: 10 },
];

export const STATION_HALF = 0.8;

export interface Seat {
  id: string;
  group: string;
  x: number;
  z: number;
  ry: number;
}

/** Sitting in one of these groups opens the face grid with everyone else seated there. */
export const GRID_GROUPS = ['lounge', 'dining'];

export const SEATS: Seat[] = [];

// Lounge: a ring of armchairs facing the lamp.
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  SEATS.push({
    id: `lounge:${i}`,
    group: 'lounge',
    x: LOUNGE.x + Math.sin(a) * 3.4,
    z: LOUNGE.z + Math.cos(a) * 3.4,
    ry: a + Math.PI,
  });
}
// Dining table: four chairs a side.
for (let i = 0; i < 4; i++) {
  const z = DINING.z - 2.1 + i * 1.4;
  SEATS.push({ id: `dining:w${i}`, group: 'dining', x: DINING.x - 1.7, z, ry: Math.PI / 2 });
  SEATS.push({ id: `dining:e${i}`, group: 'dining', x: DINING.x + 1.7, z, ry: -Math.PI / 2 });
}
// Cinema: two rows of beanbags facing the screen.
for (let row = 0; row < 2; row++) {
  for (let i = 0; i < 5; i++) {
    SEATS.push({ id: `cinema:${row}${i}`, group: 'cinema', x: -6 + i * 3, z: -9 + row * 3.2, ry: Math.PI });
  }
}

export const seatGroup = (seatId: string | null) => (seatId ? seatId.split(':')[0] : null);

/** Solid boxes you can't walk through: centre plus half-sizes. */
export interface Collider {
  x: number;
  z: number;
  hw: number;
  hd: number;
}
/** Potted plants: position and size multiplier. */
export const PLANTS: { x: number; z: number; scale: number }[] = [
  { x: -17.6, z: -17.6, scale: 1.4 },
  { x: 17.6, z: -17.6, scale: 1.4 },
  { x: -17.6, z: 17.6, scale: 1.3 },
  { x: 17.6, z: 17.6, scale: 1.3 },
  { x: -3.4, z: 18.2, scale: 1 },
  { x: 3.4, z: 18.2, scale: 1 },
  { x: -18.4, z: -7, scale: 1.2 },
  { x: -18.4, z: -1, scale: 1.2 },
];

/** Tall corner masts that hold up the billboard cables and string lights. */
export const MASTS: { x: number; z: number }[] = [
  { x: -19, z: -19 },
  { x: 19, z: -19 },
  { x: -19, z: 19 },
  { x: 19, z: 19 },
];
export const MAST_H = 15;

/** The hanging scoreboard. */
export const BILLBOARD = { x: 0, y: 12.6, z: 2, w: 6.4, h: 3.6 };

/** The pergola over the kitchen. */
export const PERGOLA = { x1: 10.7, x2: 19.9, z1: -5.5, z2: 11.5, h: 4.5 };
export const PERGOLA_POSTS: { x: number; z: number }[] = [
  { x: PERGOLA.x1, z: PERGOLA.z1 },
  { x: PERGOLA.x1, z: PERGOLA.z2 },
  { x: PERGOLA.x2, z: PERGOLA.z1 },
  { x: PERGOLA.x2, z: PERGOLA.z2 },
];

const square = (x: number, z: number, half: number): Collider => ({ x, z, hw: half, hd: half });

export const COLLIDERS: Collider[] = [
  ...STATIONS.map((s) => square(s.x, s.z, STATION_HALF)),
  { x: DINING.x, z: DINING.z, hw: 0.9, hd: 2.9 },
  square(LOUNGE.x, LOUNGE.z, 1.0), // fire pit
  ...SEATS.map((s) => square(s.x, s.z, s.group === 'dining' ? 0.4 : 0.6)),
  ...PLANTS.map((p) => square(p.x, p.z, 0.42 * p.scale)),
  ...MASTS.map((m) => square(m.x, m.z, 0.3)),
  ...PERGOLA_POSTS.map((p) => square(p.x, p.z, 0.2)),
];
