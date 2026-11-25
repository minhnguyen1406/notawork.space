import type * as THREE from 'three';
import type { Avatar } from '../avatar';
import type { Media } from '../media';
import type { BallState } from '../../shared/ball';
import type { PlayerInfo } from '../../shared/protocol';

/** Things that happen in the room that a feature may want to react to (sounds, the minimap...). */
export type ClientEvent =
  | { kind: 'join'; player: PlayerInfo } // someone came in (not fired for people already here when you arrive)
  | { kind: 'leave'; id: string; name: string }
  | { kind: 'chat'; id: string; name: string; text: string }
  | { kind: 'notice'; text: string }
  | { kind: 'goal'; score: [number, number] }
  | { kind: 'kick'; power: number; mine: boolean } // the ball was struck (by me, or its speed jumped)
  | { kind: 'emote'; id: string; k: string }
  | { kind: 'sit'; id: string; seat: string | null }
  | { kind: 'welcome' } // I have just come in (or reconnected)
  | { kind: 'lost' }; // my connection to the room dropped

/** What an add-on feature can use. One of these is built per feature. */
export interface FeatureCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  avatars: Map<string, Avatar>;
  myId(): string;
  me(): Avatar | null;
  ball(): BallState;
  /** The voice and video connection, or null if it is not connected. */
  media(): Media | null;
  /** The keys held down right now. Add or remove codes ('KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft') to steer. */
  keys: Set<string>;
  /** Act exactly as if this key had been pressed once: 'KeyE' use/sit, 'Space' shoot, 'KeyG' duel, 'KeyM' mic, 'KeyF', 'KeyH', 'Enter' chat, 'Digit1'..'Digit7'. */
  press(code: string): void;
  /** Hold-to-talk: true while held. */
  talk(held: boolean): void;
  /** Turn, tilt and zoom the camera by these amounts (radians, radians, metres). */
  look(dYaw: number, dPitch: number, dZoom: number): void;
  /** Which way the camera faces (radians), for things drawn relative to the view. */
  yaw(): number;
  /** What E would do right now, as the prompt shows it ('E — sit down'), or '' if nothing. */
  prompt(): string;
  toast(text: string): void;
  /** The in-room interface layer, and the bar of buttons at its top left. Add your own elements here. */
  hud: HTMLElement;
  topbar: HTMLElement;
  /** Listen for things happening in the room. */
  on(listener: (e: ClientEvent) => void): void;
  /** Hide or show the whole interface (photo mode). */
  setUiHidden(hidden: boolean): void;
  /** Render one frame and return it as a PNG. */
  capture(): Promise<Blob>;
  /** Remember small settings between visits (localStorage, which may be unavailable). */
  store: { get(key: string): string | null; set(key: string, value: string): void };
}

export interface Feature {
  init(ctx: FeatureCtx): void;
  /** Called every frame. */
  frame?(dt: number, time: number): void;
  /** A key was pressed outside text boxes. Return true only if you used it. */
  key?(code: string): boolean;
}
