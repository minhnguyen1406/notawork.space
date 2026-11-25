import type { PlayerInfo } from '../../../shared/protocol';

/** What a game can ask the room to do. Each game gets its own copy, bound to its id. */
export interface GameIO {
  /** Everyone in the room right now, with live positions. The Claude character has id 'claude'. */
  players(): PlayerInfo[];
  /** Send this game's state to one person. Use for anything secret (a hand of cards, a role). */
  send(id: string, view: unknown): void;
  /** Send this game's state to everyone. */
  broadcast(view: unknown): void;
  /** A line in everyone's chat log and a toast, e.g. "Lan won at tag". */
  notice(text: string): void;
  /** Show a reaction over someone's head for everyone ('👋', 'dance', any emoji). */
  emote(id: string, k: string): void;
  /** Move someone to a spot (their browser obeys). */
  put(id: string, x: number, z: number): void;
  /** Shove someone by a small amount (their browser adds it to where they are). */
  nudge(id: string, dx: number, dz: number): void;
  /** Put the football back on the centre spot, and/or set the score. */
  resetBall(): void;
  setScore(red: number, blue: number): void;
}

/** Things that happen elsewhere in the room that a game may care about. */
export type RoomEvent =
  | { kind: 'goal'; side: 'red' | 'blue'; by: string } // `side` scored; `by` is the last kicker's name
  | { kind: 'serve'; id: string; name: string; dish: string }; // someone served a dish in the kitchen

/** The server side of one game. The server is the only authority: never trust what a browser claims. */
export interface ServerGame {
  /** A player did something (pressed a button, typed a guess). `a` is whatever the browser sent: validate it. */
  onAction(p: PlayerInfo, a: Record<string, unknown>, now: number): void;
  /** Someone left the room. */
  onLeave(id: string, now: number): void;
  /** Someone arrived: send them whatever they need to see the game as it stands. */
  onJoin?(p: PlayerInfo, now: number): void;
  /** Called ten times a second. */
  tick?(now: number): void;
  onEvent?(e: RoomEvent, now: number): void;
}

export type GameFactory = (io: GameIO) => ServerGame;
