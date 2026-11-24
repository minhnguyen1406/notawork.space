// Where things are in the room. Shared so the server and the browser agree.
// Axes: +x is east, +z is south. An avatar with ry = 0 faces +z.
import type { IngType } from './kitchen';

export const SPAWN = { x: 0, z: 13 };

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
export const COLLIDERS: Collider[] = [
  ...STATIONS.map((s) => ({ x: s.x, z: s.z, hw: STATION_HALF, hd: STATION_HALF })),
  { x: DINING.x, z: DINING.z, hw: 0.9, hd: 2.9 },
  { x: LOUNGE.x, z: LOUNGE.z, hw: 0.9, hd: 0.9 },
];
