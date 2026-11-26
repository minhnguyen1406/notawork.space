// What the server tells each person sitting at a game table. Views are per person,
// so hidden things (your hand) are only ever sent to you.
import type { Card, Suit } from './cards';
import type { Role } from './werewolf';
import type { PhoGame } from './property';

export const TABLE_GROUPS = ['chess', 'cards', 'poker', 'wolf', 'pho'] as const;
export type TableId = (typeof TABLE_GROUPS)[number];
export const isTable = (g: string | null): g is TableId => (TABLE_GROUPS as readonly string[]).includes(g ?? '');

export interface ChessView {
  fen: string;
  white: string | null;
  black: string | null;
  last: { from: string; to: string } | null;
  status: 'playing' | 'checkmate' | 'stalemate' | 'draw';
  /** Which side you play, or null if you're watching. */
  you: 'w' | 'b' | null;
  /** The side played by the built-in Claude character, if it is at the board. */
  bot: 'w' | 'b' | null;
}

export type ChessAction =
  | { k: 'move'; from: string; to: string }
  | { k: 'new' }
  /** A move for the Claude character, worked out in its opponent's browser so the server stays free. */
  | { k: 'bot'; from: string; to: string };

export interface CardsView {
  phase: 'lobby' | 'play' | 'over';
  /** In turn order during a game; everyone seated while in the lobby. */
  players: { id: string; name: string; count: number }[];
  turn: string | null;
  top: Card | null;
  suit: Suit | null;
  pending: number;
  dir: 1 | -1;
  hand: Card[];
  winner: string | null;
  /** Milliseconds, counted from when this view was made, until anyone else may skip the player whose turn it is. */
  skipIn: number;
  you: string;
}

export type CardsAction = { k: 'start' } | { k: 'play'; card: Card; suit?: Suit } | { k: 'draw' } | { k: 'skip' };

export interface PokerView {
  phase: 'lobby' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  players: {
    id: string;
    name: string;
    chips: number;
    bet: number;
    folded: boolean;
    allIn: boolean;
    dealer: boolean;
    /** Your own cards always; other people's only when hands are turned over at a showdown. */
    hole: Card[] | null;
  }[];
  /** People sitting at the table who will be dealt in next hand. */
  waiting: string[];
  board: Card[];
  pot: number;
  turn: string | null;
  /** What you must add to stay in (0 means you may check). */
  toCall: number;
  /** The smallest and largest totals you may raise to, or null if you can't raise. */
  raise: { min: number; max: number } | null;
  results: string[];
  seated: number;
  /** Milliseconds, counted from when this view was made, until anyone else may skip the player whose turn it is. */
  skipIn: number;
  you: string;
}

export interface WolfView {
  phase: 'lobby' | 'night' | 'day' | 'over';
  round: number;
  /** A role is only filled in when you are allowed to know it. */
  players: { id: string; name: string; alive: boolean; role: Role | null }[];
  you: string;
  /** Your own role, or null if you are not in this game. */
  yourRole: Role | null;
  alive: boolean;
  /** What you may do tonight, and whether you have done it. */
  night: { can: 'kill' | 'look' | 'protect' | null; done: boolean; picks: { by: string; target: string }[] };
  /** What the seer has learned. Empty for everyone else. */
  notes: string[];
  votes: { by: string; target: string }[];
  myVote: string | null;
  log: string[];
  winner: 'village' | 'werewolves' | null;
  seated: number;
  /** Milliseconds until anyone may move a stalled night or day on. */
  forceIn: number;
}

export type WolfAction = { k: 'start' } | { k: 'night'; target: string } | { k: 'vote'; target: string } | { k: 'force' };

/** Nothing is hidden in the property game, so everyone gets the whole state. */
export type PhoView = Omit<PhoGame, 'winner'> & { winner: string | null; you: string; seated: number };
