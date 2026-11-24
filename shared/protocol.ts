// Messages and limits shared by the browser and the game server.
import type { KitchenState } from './kitchen';

export const ROOM_HALF = 20; // the room is a square from -20 to +20 on x and z
export const MAX_PLAYERS = 40;
export const MAX_NAME = 24;
export const MAX_CHAT = 200;
export const TICK_HZ = 10;

export const COLORS = ['#e4572e', '#f3a712', '#76b041', '#29a19c', '#3a86ff', '#8338ec', '#ff5d8f', '#f2efe6'];

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  ry: number;
  seat: string | null;
}

export type ClientMsg =
  | { t: 'join'; name: string; color: string; password?: string }
  | { t: 'move'; x: number; z: number; ry: number }
  | { t: 'chat'; text: string }
  | { t: 'sit'; seat: string | null }
  | { t: 'use'; station: string }
  | { t: 'act'; station: string }
  | { t: 'ping' };

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      players: PlayerInfo[];
      kitchen: KitchenState;
      media: { url: string; token: string } | null;
    }
  | { t: 'denied'; reason: 'full' | 'password' }
  | { t: 'join'; player: PlayerInfo }
  | { t: 'leave'; id: string }
  | { t: 'state'; players: [id: string, x: number, z: number, ry: number][] }
  | { t: 'sit'; id: string; seat: string | null }
  | { t: 'chat'; id: string; name: string; text: string }
  | { t: 'kitchen'; state: KitchenState }
  | { t: 'notice'; text: string };
