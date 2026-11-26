// The rooftop duel: two players, three hearts each, quick rounds where both secretly pick a move.
// Shared so the server (which decides) and browsers (which show it) agree on the rules.

export const MOVES = ['pillow', 'chicken', 'umbrella'] as const;
export type Move = (typeof MOVES)[number];

/** What each move is called, the picture for it, and what it beats. */
export const MOVE_INFO: Record<Move, { label: string; icon: string; beats: Move }> = {
  pillow: { label: 'Pillow', icon: '🪶', beats: 'chicken' },
  chicken: { label: 'Rubber chicken', icon: '🐔', beats: 'umbrella' },
  umbrella: { label: 'Umbrella', icon: '☂️', beats: 'pillow' },
};

export const HEARTS = 3;
export const ROUND_MS = 6000;
/** How long the result of a round stays up before the next one starts. */
export const REVEAL_MS = 2600;
export const ASK_MS = 15_000;
/** You must be this close to challenge someone, and stay this close during the duel. */
export const DUEL_REACH = 4.5;
export const DUEL_LEASH = 9;
export const MAX_ROUNDS = 15;

export interface Fighter {
  id: string;
  name: string;
  hearts: number;
  /** Their move this round. Kept secret from everyone until both are in. */
  pick: Move | null;
}

export interface Duel {
  id: number;
  a: Fighter;
  b: Fighter;
  round: number;
  phase: 'pick' | 'reveal' | 'over';
  /** When the current phase ends (server clock). */
  until: number;
  /** The round just played: both moves and who lost a heart ('' if nobody). */
  last: { a: Move | null; b: Move | null; loser: string } | null;
  /** Who won the whole duel ('' for a draw), once it is over. */
  winner: string | null;
}

/** Who wins a round: 'a', 'b' or null for a tie. Not picking in time loses to any move. */
export function roundWinner(a: Move | null, b: Move | null): 'a' | 'b' | null {
  if (a === b) return null;
  if (!a) return 'b';
  if (!b) return 'a';
  return MOVE_INFO[a].beats === b ? 'a' : 'b';
}

export function newDuel(id: number, a: { id: string; name: string }, b: { id: string; name: string }, now: number): Duel {
  const fighter = (p: { id: string; name: string }): Fighter => ({ id: p.id, name: p.name, hearts: HEARTS, pick: null });
  return { id, a: fighter(a), b: fighter(b), round: 1, phase: 'pick', until: now + ROUND_MS, last: null, winner: null };
}

/** Record a move. Returns false if it isn't allowed right now. */
export function duelPick(d: Duel, pid: string, move: unknown): boolean {
  if (d.phase !== 'pick' || !MOVES.includes(move as Move)) return false;
  const f = d.a.id === pid ? d.a : d.b.id === pid ? d.b : null;
  if (!f || f.pick) return false; // one choice a round, no changing your mind
  f.pick = move as Move;
  return true;
}

/** Someone walked off, sat down or disconnected: the other fighter wins. */
export function duelForfeit(d: Duel, pid: string, now: number) {
  if (d.phase === 'over' || (d.a.id !== pid && d.b.id !== pid)) return;
  d.phase = 'over';
  d.winner = d.a.id === pid ? d.b.id : d.a.id;
  d.until = now + REVEAL_MS;
}

/** Move the duel on if its clock has run out or both moves are in. Returns true if anything changed. */
export function duelTick(d: Duel, now: number): boolean {
  if (!Number.isFinite(now)) return false; // a broken clock must not end a round or freeze the reveal
  if (d.phase === 'pick') {
    if (now < d.until && !(d.a.pick && d.b.pick)) return false;
    const w = roundWinner(d.a.pick, d.b.pick);
    const loser = w === 'a' ? d.b : w === 'b' ? d.a : null;
    if (loser) loser.hearts--;
    d.last = { a: d.a.pick, b: d.b.pick, loser: loser?.id ?? '' };
    d.a.pick = d.b.pick = null;
    if (d.a.hearts === 0 || d.b.hearts === 0) {
      d.phase = 'over';
      d.winner = d.a.hearts === 0 ? d.b.id : d.a.id;
    } else if (d.round >= MAX_ROUNDS) {
      d.phase = 'over';
      d.winner = d.a.hearts === d.b.hearts ? '' : d.a.hearts > d.b.hearts ? d.a.id : d.b.id;
    } else d.phase = 'reveal';
    d.until = now + REVEAL_MS;
    return true;
  }
  if (d.phase === 'reveal' && now >= d.until) {
    d.round++;
    d.phase = 'pick';
    d.until = now + ROUND_MS;
    return true;
  }
  return false;
}

/** What everyone is allowed to see: the moves stay hidden while a round is being picked. */
export interface DuelView {
  id: number;
  a: { id: string; name: string; hearts: number; ready: boolean };
  b: { id: string; name: string; hearts: number; ready: boolean };
  round: number;
  phase: Duel['phase'];
  /** Milliseconds left in the current phase. */
  left: number;
  last: Duel['last'];
  winner: string | null;
}

export const duelView = (d: Duel, now: number): DuelView => ({
  id: d.id,
  a: { id: d.a.id, name: d.a.name, hearts: d.a.hearts, ready: !!d.a.pick },
  b: { id: d.b.id, name: d.b.name, hearts: d.b.hearts, ready: !!d.b.pick },
  round: d.round,
  phase: d.phase,
  left: Math.max(0, d.until - now),
  last: d.last,
  winner: d.winner,
});
