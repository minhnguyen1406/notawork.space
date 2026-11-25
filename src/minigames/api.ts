import type * as THREE from 'three';
import type { Avatar } from '../avatar';
import type { Sound } from '../fun';

/** What a game can use in the browser. */
export interface GameCtx {
  scene: THREE.Scene;
  /** Everyone's character, by player id. */
  avatars: Map<string, Avatar>;
  myId(): string;
  me(): Avatar | null;
  /** Send an action to this game's server side. */
  send(a: Record<string, unknown>): void;
  toast(text: string): void;
  /** This game's own box on the page, hidden to begin with. Fill it and set `hidden` yourself. */
  panel: HTMLElement;
  confetti(pieces?: string[]): void;
  play(sound: Sound): void;
  /** Stop (or allow) my walking, e.g. while rooted to the spot. */
  freeze(on: boolean): void;
  /** Multiply my walking speed (1 is normal). */
  speed(mult: number): void;
  /** Move me somewhere at once. */
  put(x: number, z: number): void;
}

/** The browser side of one game. */
export interface ClientGame {
  /** Called once at start-up. Build any 3D objects and remember `ctx`. */
  init(ctx: GameCtx): void;
  /** The server sent this game's state. */
  onView(view: unknown): void;
  /** The player pressed E at this game's signpost. */
  open(): void;
  /** Called every frame. */
  frame?(dt: number, time: number): void;
  /** A key was pressed (outside text boxes). Return true if the game used it. */
  key?(code: string): boolean;
  /** The room connection was lost and regained: forget everything. */
  reset?(): void;
}
