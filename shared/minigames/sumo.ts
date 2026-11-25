// Sumo ring: push the others out of the circle. Last one in wins the round; first to two rounds wins.
// Rules only: no browser or server code in this file.
import { GAME_ZONES } from '../minigames';

export const SUMO_MIN = 2;
export const SUMO_MAX = 8;
/** Rounds needed to win the match. */
export const SUMO_WINS = 2;
export const COUNTDOWN_MS = 3_000;
/** A round that lasts this long goes to whoever is nearest the centre. */
export const ROUND_MS = 60_000;
/** How long a round's result stays up before the next round. */
export const RESULT_MS = 3_000;
/** Two players closer than this are touching, and get pushed apart. */
export const SUMO_REACH = 1.2;
/** The most anyone can be pushed in one tick, in metres. */
export const PUSH_CAP = 0.6;
/** How much of a charger's extra speed carries into the person they hit. */
const CARRY = 0.5;
/** A little "speed" everyone has, so two people standing still share the push evenly. */
const REST = 0.02;

export interface Ring {
  x: number;
  z: number;
  r: number;
}
export interface Vec {
  dx: number;
  dz: number;
}
/** Where someone is now (x, z) and where they were a tick ago (px, pz). */
export interface Mover {
  x: number;
  z: number;
  px: number;
  pz: number;
}

/**
 * The push between two players this tick, or null if they are not touching. Each is moved away
 * from the other. The overlap is split by how fast each was closing in, so the one charging
 * gives most of it to the other; a charger faster than their opponent also carries them further.
 * Equal charges cancel: both are simply held apart.
 */
export function sumoPush(a: Mover, b: Mover): { a: Vec; b: Vec } | null {
  let nx = b.x - a.x;
  let nz = b.z - a.z;
  const d = Math.hypot(nx, nz);
  if (d >= SUMO_REACH) return null;
  // Standing on exactly the same spot: any direction will do, as long as it is always the same.
  if (d < 1e-6) [nx, nz] = [1, 0];
  else [nx, nz] = [nx / d, nz / d];
  // Metres each moved towards the other since the last tick. Backing away counts as nothing.
  const va = Math.max(0, (a.x - a.px) * nx + (a.z - a.pz) * nz);
  const vb = Math.max(0, -((b.x - b.px) * nx + (b.z - b.pz) * nz));
  const overlap = SUMO_REACH - d;
  const shareA = (va + REST) / (va + vb + 2 * REST);
  const onB = Math.min(PUSH_CAP, overlap * shareA + Math.max(0, va - vb) * CARRY);
  const onA = Math.min(PUSH_CAP, overlap * (1 - shareA) + Math.max(0, vb - va) * CARRY);
  return { a: { dx: -nx * onA, dz: -nz * onA }, b: { dx: nx * onB, dz: nz * onB } };
}

/** Every push in a crowd, added up per player and capped again. Players nobody touches are left out. */
export function sumoPushes(movers: Record<string, Mover>): Record<string, Vec> {
  const ids = Object.keys(movers);
  const out: Record<string, Vec> = {};
  const add = (id: string, v: Vec) => {
    const o = (out[id] ??= { dx: 0, dz: 0 });
    o.dx += v.dx;
    o.dz += v.dz;
  };
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const p = sumoPush(movers[ids[i]], movers[ids[j]]);
      if (!p) continue;
      add(ids[i], p.a);
      add(ids[j], p.b);
    }
  for (const v of Object.values(out)) {
    const len = Math.hypot(v.dx, v.dz);
    if (len > PUSH_CAP) [v.dx, v.dz] = [(v.dx / len) * PUSH_CAP, (v.dz / len) * PUSH_CAP];
  }
  return out;
}

/** Starting spots for `n` players: evenly round the inside of the ring. */
export function sumoPlaces(n: number, ring: Ring = GAME_ZONES.sumo): { x: number; z: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: ring.x + Math.sin(a) * ring.r * 0.6, z: ring.z + Math.cos(a) * ring.r * 0.6 };
  });
}

/** A spot just outside the ring, straight out from the centre through (x, z). */
export function sumoOutside(x: number, z: number, ring: Ring = GAME_ZONES.sumo): { x: number; z: number } {
  const d = Math.hypot(x - ring.x, z - ring.z);
  const [nx, nz] = d < 1e-6 ? [1, 0] : [(x - ring.x) / d, (z - ring.z) / d];
  return { x: ring.x + nx * (ring.r + 1.2), z: ring.z + nz * (ring.r + 1.2) };
}

export interface SumoGame {
  /** Who is playing, in the order they joined. */
  players: { id: string; name: string }[];
  /** lobby → countdown → bout → result → countdown … → lobby. */
  phase: 'lobby' | 'countdown' | 'bout' | 'result';
  /** Who is still in the ring this round. */
  alive: string[];
  /** Rounds won this match, by player id. */
  wins: Record<string, number>;
  round: number;
  /** When the current phase ends (server clock). */
  until: number;
  /** Who won the last round (null if nobody did). */
  last: string | null;
  /** Who won the last match, kept for the lobby to show. */
  champion: { id: string; name: string } | null;
}

/** Things that happened, for the server to act on (move people, show reactions, announce). */
export type SumoEvent =
  | { k: 'place' } // a round is starting: put everyone in `alive` on their spots
  | { k: 'go' }
  | { k: 'out'; id: string }
  | { k: 'round'; id: string | null; timeout: boolean }
  | { k: 'match'; id: string; name: string }
  | { k: 'abandon' }; // too few players left to carry on

export const newSumo = (): SumoGame => ({ players: [], phase: 'lobby', alive: [], wins: {}, round: 0, until: 0, last: null, champion: null });

/** Joining is only possible between matches. */
export function sumoJoin(g: SumoGame, p: { id: string; name: string }): boolean {
  if (g.phase !== 'lobby' || g.players.length >= SUMO_MAX || g.players.some((x) => x.id === p.id)) return false;
  g.players.push({ id: p.id, name: p.name });
  return true;
}

function beginRound(g: SumoGame, now: number, ev: SumoEvent[]) {
  g.round++;
  g.alive = g.players.map((p) => p.id);
  g.phase = 'countdown';
  g.until = now + COUNTDOWN_MS;
  ev.push({ k: 'place' });
}

function toLobby(g: SumoGame) {
  g.phase = 'lobby';
  g.alive = [];
  g.until = 0;
}

function endRound(g: SumoGame, winner: string | null, timeout: boolean, now: number, ev: SumoEvent[]) {
  g.last = winner;
  g.alive = [];
  ev.push({ k: 'round', id: winner, timeout });
  const who = g.players.find((p) => p.id === winner);
  if (who) g.wins[who.id] = (g.wins[who.id] ?? 0) + 1;
  if (who && g.wins[who.id] >= SUMO_WINS) {
    g.champion = { id: who.id, name: who.name };
    toLobby(g);
    ev.push({ k: 'match', id: who.id, name: who.name });
  } else {
    g.phase = 'result';
    g.until = now + RESULT_MS;
  }
}

/** Anyone in the game starts a match. */
export function sumoStart(g: SumoGame, by: string, now: number): SumoEvent[] {
  if (g.phase !== 'lobby' || g.players.length < SUMO_MIN || g.players.length > SUMO_MAX || !g.players.some((p) => p.id === by)) return [];
  g.wins = {};
  g.round = 0;
  g.last = null;
  g.champion = null;
  const ev: SumoEvent[] = [];
  beginRound(g, now, ev);
  return ev;
}

/** Someone left the game or the room. Returns what happened; `null` if they were not playing. */
export function sumoLeave(g: SumoGame, id: string, now: number): SumoEvent[] | null {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  g.players.splice(i, 1);
  delete g.wins[id];
  const wasIn = g.alive.includes(id);
  g.alive = g.alive.filter((x) => x !== id);
  const ev: SumoEvent[] = [];
  if (g.phase === 'lobby') return ev;
  if (g.players.length < SUMO_MIN) {
    toLobby(g);
    ev.push({ k: 'abandon' });
  } else if (wasIn && g.phase !== 'result' && g.alive.length <= 1) endRound(g, g.alive[0] ?? null, false, now, ev);
  return ev;
}

const nearest = (ids: string[], where: (id: string) => { x: number; z: number } | null, ring: Ring): string | null => {
  let best: string | null = null;
  let bestD = Infinity;
  for (const id of ids) {
    const p = where(id);
    const d = p ? Math.hypot(p.x - ring.x, p.z - ring.z) : Infinity;
    if (best === null || d < bestD) [best, bestD] = [id, d];
  }
  return best;
};

/**
 * Time passing. `where` gives a player's real position (null if they are no longer in the room).
 * Sitting down, vanishing or being outside the ring puts you out.
 */
export function sumoTick(
  g: SumoGame,
  now: number,
  where: (id: string) => { x: number; z: number; seat?: string | null } | null,
  ring: Ring = GAME_ZONES.sumo,
): SumoEvent[] {
  const ev: SumoEvent[] = [];
  if (g.phase === 'lobby') return ev;
  if (g.phase === 'result') {
    if (now >= g.until) beginRound(g, now, ev);
    return ev;
  }
  // During the countdown people are rooted, so only giving up (sitting, leaving) counts.
  const out = g.alive.filter((id) => {
    const p = where(id);
    return !p || !!p.seat || (g.phase === 'bout' && Math.hypot(p.x - ring.x, p.z - ring.z) > ring.r);
  });
  if (out.length) {
    for (const id of out) ev.push({ k: 'out', id });
    g.alive = g.alive.filter((id) => !out.includes(id));
    if (g.alive.length <= 1) {
      // Everyone left went out on the same tick: whoever of them is closest to the centre takes it.
      const upright = out.filter((id) => !where(id)?.seat && where(id));
      endRound(g, g.alive[0] ?? nearest(upright, where, ring), false, now, ev);
      return ev;
    }
  }
  if (now < g.until) return ev;
  if (g.phase === 'countdown') {
    g.phase = 'bout';
    g.until = now + ROUND_MS;
    ev.push({ k: 'go' });
  } else endRound(g, nearest(g.alive, where, ring), true, now, ev);
  return ev;
}

/** What everyone sees. Nothing in this game is secret. */
export interface SumoView {
  players: { id: string; name: string; wins: number }[];
  phase: SumoGame['phase'];
  alive: string[];
  round: number;
  /** Milliseconds left in this phase. */
  left: number;
  last: string | null;
  champion: { id: string; name: string } | null;
}

export const sumoView = (g: SumoGame, now: number): SumoView => ({
  players: g.players.map((p) => ({ id: p.id, name: p.name, wins: g.wins[p.id] ?? 0 })),
  phase: g.phase,
  alive: g.alive,
  round: g.round,
  left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
  last: g.last,
  champion: g.champion,
});

/** What a browser may send. */
export type SumoAction = { k: 'join' } | { k: 'leave' } | { k: 'start' };
