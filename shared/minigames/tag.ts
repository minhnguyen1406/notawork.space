// Tag: one player is "it" and passes it on by getting close. Least time spent as "it" wins.
// Rules only: no browser or server code in this file.

export const TAG_MIN = 2;
export const TAG_MAX = 20;
/** The pause between pressing Start and someone becoming "it". */
export const COUNTDOWN_MS = 3_000;
export const GAME_MS = 120_000;
/** How close "it" has to get, in metres. */
export const TAG_REACH = 1.4;
/** A freshly tagged player cannot move for this long, so they can't tag straight back. */
export const ROOT_MS = 1_500;
/** The player who just made a tag cannot be tagged for this long. */
export const SAFE_MS = 3_000;
/** How much faster "it" walks. */
export const IT_SPEED = 1.12;

export interface TagPlayer {
  id: string;
  name: string;
  /** Milliseconds spent as "it" this game. */
  itMs: number;
}

/** Where someone in the room is right now, as the server sees it. */
export interface TagSpot {
  id: string;
  x: number;
  z: number;
  seat: string | null;
}

export interface TagGame {
  /** Who is playing, in the order they joined. */
  players: TagPlayer[];
  phase: 'lobby' | 'countdown' | 'play';
  it: string | null;
  /** When the countdown or the game ends (server clock). */
  until: number;
  /** Up to when "it" time has been added up. */
  last: number;
  /** The player rooted to the spot after being tagged, and where. */
  root: { id: string; until: number; x: number; z: number } | null;
  /** The last tagger, who cannot be tagged back yet. */
  safe: { id: string; until: number } | null;
  /** The ranking of the last finished game, best first. */
  results: TagPlayer[] | null;
  winners: string[];
}

/** What happened, so the server can announce it. */
export type TagEvent =
  | { k: 'join' }
  | { k: 'countdown' }
  | { k: 'go'; it: string }
  | { k: 'tag'; from: string; to: string }
  | { k: 'out'; id: string }
  /** "It" left, so someone else was picked. */
  | { k: 'it'; id: string }
  /** Too few players left. */
  | { k: 'stop' }
  | { k: 'end'; results: TagPlayer[]; winners: string[] };

export const newTag = (): TagGame => ({ players: [], phase: 'lobby', it: null, until: 0, last: 0, root: null, safe: null, results: null, winners: [] });

const has = (g: TagGame, id: string) => g.players.some((p) => p.id === id);
const pick = <T>(list: T[], rnd: () => number): T => list[Math.min(list.length - 1, Math.floor(rnd() * list.length))];
const toLobby = (g: TagGame) => Object.assign(g, { phase: 'lobby', it: null, root: null, safe: null });

/** Add the time since the last count to whoever is "it", never past the final whistle. */
function accrue(g: TagGame, now: number) {
  const upTo = Math.min(now, g.until);
  const p = g.players.find((x) => x.id === g.it);
  if (p && upTo > g.last) p.itMs += upTo - g.last;
  g.last = Math.max(g.last, upTo);
}

/** Joining is only possible between games: arriving late would be an unfair head start. */
export function tagJoin(g: TagGame, p: { id: string; name: string }): boolean {
  if (g.phase !== 'lobby' || g.players.length >= TAG_MAX || has(g, p.id)) return false;
  g.players.push({ id: p.id, name: p.name, itMs: 0 });
  return true;
}

/** Anyone in the game may start it. */
export function tagStart(g: TagGame, by: string, now: number): boolean {
  if (g.phase !== 'lobby' || g.players.length < TAG_MIN || !has(g, by)) return false;
  for (const p of g.players) p.itMs = 0;
  Object.assign(g, { phase: 'countdown', until: now + COUNTDOWN_MS, it: null, root: null, safe: null, results: null, winners: [] });
  return true;
}

/** Someone left the game, sat down or left the room. An empty list means nothing changed. */
export function tagLeave(g: TagGame, id: string, now: number, rnd: () => number = Math.random): TagEvent[] {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return [];
  if (g.phase === 'play') accrue(g, now);
  g.players.splice(i, 1);
  const ev: TagEvent[] = [{ k: 'out', id }];
  if (g.root?.id === id) g.root = null;
  if (g.safe?.id === id) g.safe = null;
  if (g.phase === 'lobby') return ev;
  if (g.players.length < TAG_MIN) {
    toLobby(g);
    ev.push({ k: 'stop' });
  } else if (g.phase === 'play' && g.it === id) {
    // A fresh start: nobody is rooted or protected from the new "it".
    g.it = pick(g.players, rnd).id;
    g.root = g.safe = null;
    ev.push({ k: 'it', id: g.it });
  }
  return ev;
}

/**
 * Time passing. `here` is everyone in the room with their real positions.
 * Returns what happened; an empty list means nothing to tell anyone.
 */
export function tagTick(g: TagGame, now: number, here: TagSpot[], rnd: () => number = Math.random): TagEvent[] {
  if (g.phase === 'lobby') return [];
  const ev: TagEvent[] = [];
  const spot = new Map(here.map((s) => [s.id, s]));
  // Sitting down (or vanishing from the room) takes you out of the game.
  for (const p of [...g.players]) {
    const s = spot.get(p.id);
    if (!s || s.seat !== null) ev.push(...tagLeave(g, p.id, now, rnd));
  }
  if (g.phase === 'countdown' && now >= g.until) {
    g.it = pick(g.players, rnd).id;
    g.phase = 'play';
    g.last = g.until;
    g.until += GAME_MS;
    ev.push({ k: 'go', it: g.it });
  }
  if (g.phase !== 'play') return ev;

  accrue(g, now);
  if (now >= g.until) {
    const results = [...g.players].sort((a, b) => a.itMs - b.itMs).map((p) => ({ ...p }));
    const winners = results.filter((p) => p.itMs === results[0].itMs).map((p) => p.id);
    toLobby(g);
    g.results = results;
    g.winners = winners;
    ev.push({ k: 'end', results, winners });
    return ev;
  }

  if (g.root && now >= g.root.until) g.root = null;
  if (g.safe && now >= g.safe.until) g.safe = null;
  const it = g.it ? spot.get(g.it) : undefined;
  // A rooted "it" cannot tag, whatever their browser lets them do.
  if (!it || g.root?.id === g.it) return ev;
  let best: TagSpot | null = null;
  let bestD = TAG_REACH;
  for (const p of g.players) {
    const s = spot.get(p.id);
    if (!s || p.id === g.it || g.safe?.id === p.id) continue;
    const d = Math.hypot(s.x - it.x, s.z - it.z);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  if (best) {
    const from = g.it!;
    g.it = best.id;
    g.root = { id: best.id, until: now + ROOT_MS, x: best.x, z: best.z };
    g.safe = { id: from, until: now + SAFE_MS };
    ev.push({ k: 'tag', from, to: best.id });
  }
  return ev;
}

/** What everyone sees. Nothing in this game is secret. */
export interface TagView {
  players: TagPlayer[];
  phase: TagGame['phase'];
  it: string | null;
  /** Milliseconds left of the countdown or the game. */
  left: number;
  /** Who is rooted to the spot, and for how much longer. */
  root: string | null;
  rootLeft: number;
  /** Who just made a tag (cannot be tagged back yet). */
  safe: string | null;
  results: TagPlayer[] | null;
  winners: string[];
}

export const tagView = (g: TagGame, now: number): TagView => {
  const rootLeft = g.root ? Math.max(0, g.root.until - now) : 0;
  return {
    players: g.players,
    phase: g.phase,
    it: g.it,
    left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
    root: rootLeft ? g.root!.id : null,
    rootLeft,
    safe: g.safe && g.safe.until > now ? g.safe.id : null,
    results: g.results,
    winners: g.winners,
  };
};

/** What a browser may send. */
export type TagAction = { k: 'join' } | { k: 'leave' } | { k: 'start' };

/** "1:05" for a clock, from milliseconds. */
export const tagClock = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
