// What the server tells each person sitting at a game table. Views are per person,
// so hidden things (your hand) are only ever sent to you.
import type { Card, Suit } from './cards';

export const TABLE_GROUPS = ['chess', 'cards', 'poker'] as const;
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
}

export type ChessAction = { k: 'move'; from: string; to: string } | { k: 'new' };

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
  you: string;
}

export type CardsAction = { k: 'start' } | { k: 'play'; card: Card; suit?: Suit } | { k: 'draw' };

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
  you: string;
}
