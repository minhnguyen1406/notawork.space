// Cook-off: a timed team contest laid over the room's kitchen. The kitchen itself is untouched; this only
// listens for dishes being served and keeps score for the people who signed up.
// Rules only: no browser or server code in this file.
import { RECIPES } from '../kitchen';

export type Team = 'red' | 'blue';
export const TEAMS: Team[] = ['red', 'blue'];
export const TEAM_NAME: Record<Team, string> = { red: 'Red', blue: 'Blue' };
export const TEAM_BADGE: Record<Team, string> = { red: '🔴', blue: '🔵' };

export const COOKOFF_MIN = 2;
export const COOKOFF_MAX = 20;
export const COUNTDOWN_MS = 3_000;
export const ROUND_MS = 180_000;
/** How long an order stands before it is swapped for another. */
export const ORDER_MS = 45_000;
/** How many recent serves the panel shows. */
export const FEED_LEN = 4;

export interface CookPlayer {
  id: string;
  name: string;
  team: Team;
  /** Points this person has earned for their team in the current contest. */
  pts: number;
}
export interface CookOrder {
  dish: string;
  /** When it is swapped for another (server clock). */
  until: number;
}
export interface CookServe {
  name: string;
  team: Team;
  dish: string;
  pts: number;
  /** It was the team's order, so the points were doubled. */
  bonus: boolean;
}
export interface CookResult {
  red: number;
  blue: number;
  winner: Team | 'draw';
  /** The winner won because the other side had nobody left. */
  forfeit: boolean;
  top: { name: string; pts: number } | null;
}

export interface CookoffGame {
  /** Who is taking part, in the order they joined. */
  players: CookPlayer[];
  phase: 'lobby' | 'countdown' | 'play';
  /** When the countdown or the round ends (server clock). */
  until: number;
  score: Record<Team, number>;
  order: Record<Team, CookOrder | null>;
  /** The most recent serves that counted, newest last. */
  feed: CookServe[];
  /** How the last contest ended, shown in the lobby. */
  last: CookResult | null;
}

export const newCookoff = (): CookoffGame => ({
  players: [],
  phase: 'lobby',
  until: 0,
  score: { red: 0, blue: 0 },
  order: { red: null, blue: null },
  feed: [],
  last: null,
});

const other = (t: Team): Team => (t === 'red' ? 'blue' : 'red');
export const teamSize = (g: CookoffGame, t: Team) => g.players.filter((p) => p.team === t).length;

/** 1 point for two ingredients, 2 for three, 3 for four or more; 1 for a dish we do not know. */
export function dishPoints(dish: string): number {
  const n = RECIPES.find((r) => r.name === dish)?.items.length ?? 2;
  return n >= 4 ? 3 : n === 3 ? 2 : 1;
}

function newOrder(prev: string | null, now: number, rnd: () => number): CookOrder {
  // Never the same order twice running, so a swap is always visible.
  const pool = RECIPES.filter((r) => r.name !== prev);
  return { dish: pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))].name, until: now + ORDER_MS };
}

/** Join: dealt to the smaller side (a coin toss when they are level). Works mid-contest too. */
export function cookJoin(g: CookoffGame, p: { id: string; name: string }, rnd: () => number = Math.random): boolean {
  if (g.players.length >= COOKOFF_MAX || g.players.some((x) => x.id === p.id)) return false;
  const r = teamSize(g, 'red');
  const b = teamSize(g, 'blue');
  const team: Team = r < b ? 'red' : b < r ? 'blue' : rnd() < 0.5 ? 'red' : 'blue';
  g.players.push({ id: p.id, name: p.name, team, pts: 0 });
  return true;
}

/** Change sides in the lobby, as long as the sides stay within one of each other. */
export function cookSwitch(g: CookoffGame, id: string): boolean {
  const p = g.players.find((x) => x.id === id);
  if (!p || g.phase !== 'lobby') return false;
  const from = teamSize(g, p.team) - 1;
  const to = teamSize(g, other(p.team)) + 1;
  if (Math.abs(from - to) > 1) return false;
  p.team = other(p.team);
  return true;
}

/** Anyone taking part can start. People leaving may have left the sides lopsided, so even them out first. */
export function cookStart(g: CookoffGame, by: string, now: number): boolean {
  if (g.phase !== 'lobby' || g.players.length < COOKOFF_MIN || !g.players.some((p) => p.id === by)) return false;
  for (;;) {
    const big: Team = teamSize(g, 'red') > teamSize(g, 'blue') ? 'red' : 'blue';
    if (teamSize(g, big) - teamSize(g, other(big)) <= 1) break;
    // The most recent arrival on the bigger side moves across.
    const mover = [...g.players].reverse().find((p) => p.team === big)!;
    mover.team = other(big);
  }
  for (const p of g.players) p.pts = 0;
  Object.assign(g, { phase: 'countdown', until: now + COUNTDOWN_MS, score: { red: 0, blue: 0 }, order: { red: null, blue: null }, feed: [], last: null });
  return true;
}

function finish(g: CookoffGame, forfeitTo: Team | null): CookResult {
  const { red, blue } = g.score;
  const best = g.players.reduce<CookPlayer | null>((a, p) => (p.pts > (a?.pts ?? 0) ? p : a), null);
  const result: CookResult = {
    red,
    blue,
    winner: forfeitTo ?? (red > blue ? 'red' : blue > red ? 'blue' : 'draw'),
    forfeit: !!forfeitTo,
    top: best ? { name: best.name, pts: best.pts } : null,
  };
  Object.assign(g, { phase: 'lobby', until: 0, order: { red: null, blue: null }, last: result });
  return result;
}

/**
 * Someone left the contest or the room. A side with nobody left forfeits.
 * Returns null if they were not taking part, otherwise whether that ended the contest.
 */
export function cookLeave(g: CookoffGame, id: string): { ended: CookResult | null } | null {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const [gone] = g.players.splice(i, 1);
  if (g.phase === 'lobby' || teamSize(g, gone.team) > 0) return { ended: null };
  if (g.phase === 'play' && g.players.length) return { ended: finish(g, other(gone.team)) };
  // Still counting down, or nobody at all is left: nothing to award, just go back to the lobby.
  Object.assign(g, { phase: 'lobby', until: 0, order: { red: null, blue: null } });
  return { ended: null };
}

/** A dish was served in the kitchen. Counts only for someone in the contest while the clock is running. */
export function cookServe(g: CookoffGame, id: string, dish: string, now: number, rnd: () => number = Math.random): CookServe | null {
  const p = g.players.find((x) => x.id === id);
  if (!p || g.phase !== 'play' || now >= g.until) return null;
  // The kitchen always names what it serves; anything else is not a dish.
  if (typeof dish !== 'string' || !dish) return null;
  const order = g.order[p.team];
  const bonus = !!order && order.dish === dish && now < order.until;
  const pts = dishPoints(dish) * (bonus ? 2 : 1);
  p.pts += pts;
  g.score[p.team] += pts;
  if (bonus) g.order[p.team] = newOrder(dish, now, rnd);
  const serve: CookServe = { name: p.name, team: p.team, dish, pts, bonus };
  g.feed.push(serve);
  if (g.feed.length > FEED_LEN) g.feed.shift();
  return serve;
}

/** Time passing: the countdown ends, stale orders are swapped, the round ends. */
export function cookTick(g: CookoffGame, now: number, rnd: () => number = Math.random): { changed: boolean; go?: boolean; ended?: CookResult } {
  if (g.phase === 'countdown' && now >= g.until) {
    g.phase = 'play';
    g.until = now + ROUND_MS;
    for (const t of TEAMS) g.order[t] = newOrder(null, now, rnd);
    return { changed: true, go: true };
  }
  if (g.phase !== 'play') return { changed: false };
  if (now >= g.until) return { changed: true, ended: finish(g, null) };
  let changed = false;
  for (const t of TEAMS) {
    const o = g.order[t];
    if (!o || now >= o.until) {
      g.order[t] = newOrder(o?.dish ?? null, now, rnd);
      changed = true;
    }
  }
  return { changed };
}

/** The line for the chat log when a contest ends. */
export function resultText(r: CookResult): string {
  const hi = Math.max(r.red, r.blue);
  const lo = Math.min(r.red, r.blue);
  const top = r.top ? ` Top cook: ${r.top.name} (${r.top.pts}).` : '';
  if (r.winner === 'draw') return `Cook-off: a ${r.red}–${r.blue} draw.${top}`;
  if (r.forfeit) return `Cook-off: ${TEAM_NAME[r.winner]} wins by forfeit (Red ${r.red}, Blue ${r.blue}).${top}`;
  return `Cook-off: ${TEAM_NAME[r.winner]} wins ${hi}–${lo}!${top}`;
}

/** What everyone sees. Nothing in this game is secret. */
export interface CookoffView {
  players: CookPlayer[];
  phase: CookoffGame['phase'];
  /** Milliseconds left of the countdown or the round. */
  left: number;
  score: Record<Team, number>;
  /** Each side's order: the dish, what it is worth doubled, and the milliseconds before it is swapped. */
  order: Record<Team, { dish: string; pts: number; left: number } | null>;
  feed: CookServe[];
  last: CookResult | null;
}

export function cookView(g: CookoffGame, now: number): CookoffView {
  const order = (t: Team) => {
    const o = g.order[t];
    return o ? { dish: o.dish, pts: dishPoints(o.dish) * 2, left: Math.max(0, o.until - now) } : null;
  };
  return {
    players: g.players,
    phase: g.phase,
    left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
    score: g.score,
    order: { red: order('red'), blue: order('blue') },
    feed: g.feed,
    last: g.last,
  };
}

/** What a browser may send. */
export type CookoffAction = { k: 'join' } | { k: 'leave' } | { k: 'switch' } | { k: 'start' };
