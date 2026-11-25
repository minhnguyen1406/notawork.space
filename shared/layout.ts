// Where things are in the room. Shared so the server and the browser agree.
// Axes: +x is east, +z is south. An avatar with ry = 0 faces +z.
import type { IngType } from './kitchen';

export const SPAWN = { x: 0, z: 10 };

/** The walkable roof. The original corner (cinema, lounge, kitchen) sits in the north-east. */
export const BOUNDS = { x1: -44, x2: 20, z1: -20, z2: 44 };
export const CENTRE = { x: (BOUNDS.x1 + BOUNDS.x2) / 2, z: (BOUNDS.z1 + BOUNDS.z2) / 2 };

/** Football pitch (south). Goals are at the west and east ends. */
export const PITCH = { x1: -30, x2: 6, z1: 24, z2: 41, cx: -12, cz: 32.5 };
export const GOAL_HALF = 3;

/** Lap race (west): start at gate 0, pass the others in order, finish back at gate 0. */
export const RACE: { x: number; z: number }[] = [
  { x: -23, z: 14 },
  { x: -23, z: -15 },
  { x: -41, z: -15 },
  { x: -41, z: 15 },
];
export const RACE_R = 3;
export const LAP_BOARD = { x: -27, z: 18 };

/** The wheel that picks someone at random. It faces east. */
export const WHEEL = { x: -32, z: 0 };
export const SCOREBOARD = { x: -12, z: 22.2 };

/** Places where pressing E does something that isn't a kitchen station or a seat. */
export interface Spot {
  id: 'wheel' | 'score' | 'race';
  x: number;
  z: number;
}
export const SPOTS: Spot[] = [
  { id: 'wheel', x: WHEEL.x + 2, z: WHEEL.z },
  { id: 'score', x: SCOREBOARD.x, z: SCOREBOARD.z },
  { id: 'race', x: RACE[0].x, z: RACE[0].z },
];

/** Floodlight poles at the corners of the pitch. */
export const FLOODLIGHTS: { x: number; z: number }[] = [
  { x: PITCH.x1 - 1.2, z: PITCH.z1 - 1.2 },
  { x: PITCH.x2 + 1.2, z: PITCH.z1 - 1.2 },
  { x: PITCH.x1 - 1.2, z: PITCH.z2 + 1.2 },
  { x: PITCH.x2 + 1.2, z: PITCH.z2 + 1.2 },
];

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
export const GRID_GROUPS = ['lounge', 'dining', 'chess', 'cards'];

/** The games lounge (south-east), with its sit-down game tables. */
export const GAMES_LOUNGE = { x1: 8.6, x2: 19.4, z1: 21.6, z2: 42.6, h: 4.5 };
export const CHESS_TABLE = { x: 12, z: 26 };
export const CARDS_TABLE = { x: 14.5, z: 34.5, r: 1.5 };

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

// Chess: White and Black face each other; two more chairs for people watching.
SEATS.push({ id: 'chess:0', group: 'chess', x: CHESS_TABLE.x - 1.5, z: CHESS_TABLE.z, ry: Math.PI / 2 });
SEATS.push({ id: 'chess:1', group: 'chess', x: CHESS_TABLE.x + 1.5, z: CHESS_TABLE.z, ry: -Math.PI / 2 });
SEATS.push({ id: 'chess:2', group: 'chess', x: CHESS_TABLE.x, z: CHESS_TABLE.z - 1.5, ry: 0 });
SEATS.push({ id: 'chess:3', group: 'chess', x: CHESS_TABLE.x, z: CHESS_TABLE.z + 1.5, ry: Math.PI });
// Card table: eight chairs in a ring.
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  SEATS.push({
    id: `cards:${i}`,
    group: 'cards',
    x: CARDS_TABLE.x + Math.sin(a) * (CARDS_TABLE.r + 0.85),
    z: CARDS_TABLE.z + Math.cos(a) * (CARDS_TABLE.r + 0.85),
    ry: a + Math.PI,
  });
}

/** A short description of a seat for the "press E" prompt. */
export const seatLabel = (id: string) =>
  id === 'chess:0'
    ? 'sit down to play White'
    : id === 'chess:1'
      ? 'sit down to play Black'
      : id.startsWith('chess')
        ? 'sit down to watch the chess'
        : id.startsWith('cards')
          ? 'sit down at the card table'
          : 'sit down';

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
  { x: -42.4, z: -18.4, scale: 1.4 },
  { x: -42.4, z: 42.4, scale: 1.4 },
  { x: 18.4, z: 42.4, scale: 1.4 },
  { x: -32, z: -17.5, scale: 1.1 },
  { x: -32, z: 17.5, scale: 1.1 },
  { x: 17.5, z: 41, scale: 1.2 },
  { x: 10, z: 41, scale: 1.2 },
  { x: -37, z: 26, scale: 1.2 },
  { x: -40, z: 34, scale: 1 },
  { x: -36, z: 41, scale: 1.2 },
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
  ...SEATS.map((s) => square(s.x, s.z, s.group === 'lounge' || s.group === 'cinema' ? 0.6 : 0.4)),
  square(CHESS_TABLE.x, CHESS_TABLE.z, 0.75),
  square(CARDS_TABLE.x, CARDS_TABLE.z, CARDS_TABLE.r * 0.8),
  ...PLANTS.map((p) => square(p.x, p.z, 0.42 * p.scale)),
  ...MASTS.map((m) => square(m.x, m.z, 0.3)),
  ...PERGOLA_POSTS.map((p) => square(p.x, p.z, 0.2)),
  ...FLOODLIGHTS.map((f) => square(f.x, f.z, 0.25)),
  { x: WHEEL.x, z: WHEEL.z, hw: 0.5, hd: 2.7 },
  square(SCOREBOARD.x - 3, SCOREBOARD.z - 0.9, 0.2),
  square(SCOREBOARD.x + 3, SCOREBOARD.z - 0.9, 0.2),
  { x: LAP_BOARD.x, z: LAP_BOARD.z, hw: 1.7, hd: 0.25 },
];
