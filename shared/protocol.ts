// Messages and limits shared by the browser and the game server.
import type { KitchenState } from './kitchen';
import type { BallState } from './ball';

export const MAX_PLAYERS = 40;
export const MAX_NAME = 24;
export const MAX_CHAT = 200;
export const TICK_HZ = 10;

export const COLORS = ['#e4572e', '#f3a712', '#76b041', '#29a19c', '#3a86ff', '#8338ec', '#ff5d8f', '#f2efe6'];

/** The characters people can choose to be. (Models from Kenney's Mini Characters pack.) */
export const LOOKS = ['female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f', 'male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f', 'male-g'];

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  /** Which character model they chose (one of LOOKS; the Claude character is 'robot'). */
  look: string;
  x: number;
  z: number;
  ry: number;
  seat: string | null;
}

/** What the hanging billboard shows. Fetched by the server every few minutes. */
export interface Board {
  news: { src: string; title: string }[];
  stocks: { sym: string; price: number; pct: number }[];
  at: number;
}

export interface Lap {
  name: string;
  ms: number;
}

/** Everything about the games that a newcomer needs to see. */
export interface GamesState {
  ball: BallState;
  /** Goals for Red (defends the west goal) and Blue (defends the east goal). */
  score: [red: number, blue: number];
  /** Fastest laps, best first. */
  laps: Lap[];
}

export type ClientMsg =
  | { t: 'join'; name: string; color: string; look?: string; password?: string }
  | { t: 'move'; x: number; z: number; ry: number }
  | { t: 'chat'; text: string }
  /** A reaction over your head, a dance, or a snooze (see shared/fun.ts). */
  | { t: 'emote'; k: string }
  | { t: 'sit'; seat: string | null }
  | { t: 'use'; station: string }
  | { t: 'act'; station: string }
  | { t: 'kick'; vx: number; vz: number; vy?: number }
  | { t: 'spot'; id: string }
  | { t: 'lap'; ms: number }
  | { t: 'game'; table: string; a: unknown }
  | { t: 'ping' };

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      players: PlayerInfo[];
      kitchen: KitchenState;
      board: Board;
      games: GamesState;
      media: { url: string; token: string } | null;
      /** Who last mentioned work in chat and how many ms ago, or null if nobody has. */
      work: { ago: number; by: string } | null;
    }
  | { t: 'denied'; reason: 'full' | 'password' }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string }
  | { t: 'state'; players: [id: string, x: number, z: number, ry: number][] }
  | { t: 'sit'; id: string; seat: string | null }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'kitchen'; state: KitchenState }
  | { t: 'notice'; text: string }
  | { t: 'emote'; id: string; k: string }
  /** Someone said a work word in chat. */
  | { t: 'work'; by: string; word: string }
  | { t: 'board'; board: Board }
  | { t: 'ball'; ball: BallState }
  | { t: 'score'; score: [number, number] }
  | { t: 'laps'; laps: Lap[] }
  | { t: 'wheel'; names: string[]; winner: number }
  /** Your personal view of a game table you are sitting at (see shared/tables.ts). */
  | { t: 'table'; table: string; view: unknown };
