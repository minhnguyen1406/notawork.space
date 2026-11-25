// Hide and seek: one random player counts with their eyes covered while the rest hide, then has
// three minutes to walk within reach of every one of them.
// Rules only: no browser or server code in this file.

export const HIDE_MIN = 2;
export const HIDE_MAX = 20;
/** How long the seeker is rooted and blindfolded while the others hide. */
export const HIDING_MS = 30_000;
/** How long the seeker then has to find everyone. */
export const SEEKING_MS = 180_000;
/** A hider is found when the seeker is this close (metres). */
export const FIND_RADIUS = 2;

/** Where someone really is, as the server knows it (never as a browser claims). */
export interface HideSpot {
  id: string;
  x: number;
  z: number;
  seat: string | null;
}

/** How a round ended. Names, not ids, so it still reads right after people leave. */
export interface HideResult {
  /** 'none' when the round was called off (the seeker left, or nobody was left hiding). */
  winner: 'seeker' | 'hiders' | 'none';
  seeker: string;
  /** Who was still hidden at the end. */
  hidden: string[];
  /** The last hider to be found, if anyone was. */
  lastFound: string | null;
}

export interface HideGame {
  /** Who is playing, in the order they joined. */
  players: { id: string; name: string }[];
  phase: 'lobby' | 'hiding' | 'seeking';
  seeker: string | null;
  /** Hiders found so far, in the order they were found. */
  found: string[];
  /** Name of the latest hider found, kept apart from `found` in case they leave afterwards. */
  lastFound: string | null;
  /** The latest announcement for the panel, e.g. "Bao was found!". */
  news: string | null;
  /** When the current phase ends (server clock). */
  until: number;
  /** How the last round ended, shown in the lobby until the next one starts. */
  result: HideResult | null;
}

/** What one step of the rules did, so the server knows what to announce. */
export interface HideEvents {
  changed: boolean;
  /** Ids of hiders found in this step. */
  found: string[];
  /** Set when the round ended in this step. */
  result: HideResult | null;
}

export const newHide = (): HideGame => ({ players: [], phase: 'lobby', seeker: null, found: [], lastFound: null, news: null, until: 0, result: null });

const nothing = (): HideEvents => ({ changed: false, found: [], result: null });
const nameOf = (g: HideGame, id: string | null) => g.players.find((p) => p.id === id)?.name ?? 'Someone';
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** Everyone playing who is not the seeker. */
export const hideHiders = (g: HideGame) => g.players.filter((p) => p.id !== g.seeker);
/** Hiders the seeker has not found yet. */
export const hideHidden = (g: HideGame) => hideHiders(g).filter((p) => !g.found.includes(p.id));

/** Joining is only possible between rounds: arriving half-way would give hiding places away. */
export function hideJoin(g: HideGame, p: { id: string; name: string }): boolean {
  if (g.phase !== 'lobby' || g.players.length >= HIDE_MAX || g.players.some((x) => x.id === p.id)) return false;
  g.players.push({ id: p.id, name: p.name });
  return true;
}

/** End the round and go back to the lobby, keeping the players. */
function finish(g: HideGame, winner: HideResult['winner']): HideResult {
  const result: HideResult = { winner, seeker: nameOf(g, g.seeker), hidden: hideHidden(g).map((p) => p.name), lastFound: g.lastFound };
  Object.assign(g, { phase: 'lobby', seeker: null, found: [], lastFound: null, news: null, until: 0, result });
  return result;
}

/** Anyone playing may start a round. `rnd` is injectable so tests are repeatable. */
export function hideStart(g: HideGame, by: string, now: number, rnd: () => number = Math.random): boolean {
  if (g.phase !== 'lobby' || g.players.length < HIDE_MIN || !g.players.some((p) => p.id === by)) return false;
  g.seeker = g.players[Math.min(g.players.length - 1, Math.floor(rnd() * g.players.length))].id;
  Object.assign(g, { phase: 'hiding', found: [], lastFound: null, news: null, result: null, until: now + HIDING_MS });
  return true;
}

/** Someone left the game or the room. */
export function hideLeave(g: HideGame, id: string): HideEvents {
  const i = g.players.findIndex((p) => p.id === id);
  if (i < 0) return nothing();
  if (g.phase === 'lobby') {
    g.players.splice(i, 1);
    return { changed: true, found: [], result: null };
  }
  // Without a seeker there is no game. Work out the result while they are still listed, for their name.
  if (id === g.seeker) {
    const result = finish(g, 'none');
    g.players.splice(i, 1);
    return { changed: true, found: [], result };
  }
  g.players.splice(i, 1);
  g.found = g.found.filter((x) => x !== id);
  let result: HideResult | null = null;
  if (!hideHiders(g).length) result = finish(g, 'none');
  // The only people still hidden walked away: everyone who stayed has been found.
  else if (!hideHidden(g).length) result = finish(g, 'seeker');
  return { changed: true, found: [], result };
}

/**
 * Time passing. `spots` are the real positions of everyone in the room: this is where hiders get
 * found, where the phases time out, and where players who vanished from the room are dropped.
 */
export function hideTick(g: HideGame, now: number, spots: HideSpot[]): HideEvents {
  if (g.phase === 'lobby') return nothing();
  const ev = nothing();
  const at = new Map(spots.map((s) => [s.id, s]));
  // Normally onLeave has dealt with this already; it is a safety net so the round can't wait on a ghost.
  for (const p of [...g.players]) {
    if (at.has(p.id)) continue;
    const left = hideLeave(g, p.id);
    ev.changed ||= left.changed;
    if (left.result) return { ...ev, result: left.result };
  }
  if (g.phase === 'hiding') {
    if (now < g.until) return ev;
    g.phase = 'seeking';
    g.until = now + SEEKING_MS;
    ev.changed = true;
  }
  const seeker = at.get(g.seeker ?? '');
  if (!seeker) return ev;
  for (const p of hideHidden(g)) {
    const s = at.get(p.id)!;
    // Sitting down is giving up: a seat is not a hiding place.
    if (s.seat === null && Math.hypot(s.x - seeker.x, s.z - seeker.z) > FIND_RADIUS) continue;
    g.found.push(p.id);
    g.lastFound = p.name;
    ev.found.push(p.id);
  }
  if (ev.found.length) {
    const names = ev.found.map((id) => nameOf(g, id));
    g.news = `${list(names)} ${names.length > 1 ? 'were' : 'was'} found!`;
    ev.changed = true;
  }
  if (!hideHidden(g).length) ev.result = finish(g, 'seeker');
  else if (now >= g.until) ev.result = finish(g, 'hiders');
  if (ev.result) ev.changed = true;
  return ev;
}

/** One sentence for the chat log and the panel. */
export function hideSummary(r: HideResult): string {
  const last = r.lastFound ? ` ${r.lastFound} was the last one found.` : '';
  if (r.winner === 'seeker') return `Hide and seek: ${r.seeker} found everyone and wins!${last}`;
  if (r.winner === 'hiders') return `Hide and seek: time is up! ${list(r.hidden)} stayed hidden from ${r.seeker} and ${r.hidden.length > 1 ? 'win' : 'wins'}.${last}`;
  return 'Hide and seek was called off: too few players were left.';
}

/** What everyone sees. Positions are never in it: where people are hiding is the whole secret. */
export interface HideView {
  players: { id: string; name: string }[];
  phase: HideGame['phase'];
  seeker: string | null;
  found: string[];
  news: string | null;
  /** Milliseconds left in this phase. */
  left: number;
  result: HideResult | null;
}

export const hideView = (g: HideGame, now: number): HideView => ({
  players: g.players,
  phase: g.phase,
  seeker: g.seeker,
  found: g.found,
  news: g.news,
  left: g.phase === 'lobby' ? 0 : Math.max(0, g.until - now),
  result: g.result,
});

/** What a browser may send. */
export type HideAction = { k: 'join' } | { k: 'leave' } | { k: 'start' };
