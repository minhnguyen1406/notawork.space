// Play a video: everyone in the room watches the same YouTube video in step.
// Rules only: no browser or server code in this file.

/** A YouTube video id, and nothing else. This is the only thing about a link that ever leaves the server. */
export const TUBE_ID = /^[A-Za-z0-9_-]{11}$/;
/** The only sites a link may point at. */
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
/** Longest text we bother to look at. */
const MAX_LINK = 300;

/** Nobody may seek past this, and a video left running stops itself here (the server never learns a video's length). */
export const TUBE_MAX_S = 12 * 3600;
/** Each person may do this many things in this long. */
export const TUBE_RATE = 8;
export const TUBE_RATE_MS = 10_000;
/** The id of the Claude character, who does not count as an audience. */
const NPC = 'claude';

/**
 * The video id in a pasted link, or null. Understands youtube.com/watch?v=ID, youtu.be/ID,
 * youtube.com/shorts/ID, /live/ID, /embed/ID and a bare id. Anything else is refused.
 */
export function parseTube(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_LINK) return null;
  if (TUBE_ID.test(s)) return s;
  // No spaces, control characters or backslashes: a link has none, and URL parsers "repair" them.
  if (/[\s\\\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try {
    // People paste "youtube.com/watch?v=…" without the https. Any other scheme (javascript:, data:)
    // ends up as a nonsense host here and fails the host check below.
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  // The parser quietly mends things like "https:////host"; only take what was a plain link to begin with.
  if (!/^https?:\/\/[a-z0-9]/i.test(u.href) || !/^(https?:\/\/)?[a-z0-9]/i.test(s)) return null;
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (SHORT_HOSTS.has(host)) {
    if (parts.length === 1) id = parts[0];
  } else if (HOSTS.has(host)) {
    if (parts.length === 1 && parts[0] === 'watch') id = u.searchParams.get('v');
    else if (parts.length === 2 && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')) id = parts[1];
  }
  return id !== null && TUBE_ID.test(id) ? id : null;
}

export interface TubeGame {
  /** What is on, or null for nothing. */
  id: string | null;
  playing: boolean;
  /** The position in seconds at the moment `at`. */
  base: number;
  /** Server clock when `base` was true. */
  at: number;
  /** Who put it on. */
  by: { id: string; name: string } | null;
  /** When each person last did things, for the rate limit. */
  hits: Record<string, number[]>;
}

export const newTube = (): TubeGame => ({ id: null, playing: false, base: 0, at: 0, by: null, hits: {} });

/** Where the video is now, in seconds: the server's clock is the only one that counts. */
export function tubePos(g: TubeGame, now: number): number {
  if (!g.id) return 0;
  const p = g.playing ? g.base + Math.max(0, now - g.at) / 1000 : g.base;
  return Math.min(TUBE_MAX_S, Math.max(0, p));
}

/** Count one action against a person. False means they are going too fast and the action is dropped. */
export function tubeAllow(g: TubeGame, by: string, now: number): boolean {
  const recent = (g.hits[by] ?? []).filter((t) => now - t < TUBE_RATE_MS);
  const ok = recent.length < TUBE_RATE;
  if (ok) recent.push(now);
  g.hits[by] = recent;
  return ok;
}

/** Put a video on from the start. `link` is whatever the browser sent. */
export function tubePlay(g: TubeGame, by: { id: string; name: string }, link: unknown, now: number): boolean {
  const id = parseTube(link);
  if (!id) return false;
  Object.assign(g, { id, playing: true, base: 0, at: now, by: { id: by.id, name: by.name } });
  return true;
}

export function tubePause(g: TubeGame, now: number): boolean {
  if (!g.id || !g.playing) return false;
  g.base = tubePos(g, now);
  g.at = now;
  g.playing = false;
  return true;
}

export function tubeResume(g: TubeGame, now: number): boolean {
  if (!g.id || g.playing) return false;
  g.at = now;
  g.playing = true;
  return true;
}

/** Jump to `t` seconds, keeping it playing or paused as it was. */
export function tubeSeek(g: TubeGame, t: unknown, now: number): boolean {
  if (!g.id || typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > TUBE_MAX_S) return false;
  g.base = t;
  g.at = now;
  return true;
}

export function tubeStop(g: TubeGame): boolean {
  if (!g.id) return false;
  Object.assign(g, { id: null, playing: false, base: 0, at: 0, by: null });
  return true;
}

/** Someone left. `ids` is everyone still in the room: with no people left (Claude does not count) the video stops. */
export function tubeLeave(g: TubeGame, id: string, ids: string[]): boolean {
  delete g.hits[id];
  return !ids.some((x) => x !== id && x !== NPC) && tubeStop(g);
}

/** Time passing: a video left running for half a day stops itself. */
export function tubeTick(g: TubeGame, now: number): boolean {
  return !!g.id && g.playing && tubePos(g, now) >= TUBE_MAX_S && tubeStop(g);
}

/** What everyone sees. Nothing here is secret, and the only part of a link in it is the checked id. */
export interface TubeView {
  id: string | null;
  /** Both as of the moment this was sent: the browser adds the time since it arrived. */
  playing: boolean;
  pos: number;
  /** Who put it on. */
  by: string | null;
  /** Only ever sent to one person: why their last action was refused. */
  err?: 'link' | 'slow';
}

export const tubeView = (g: TubeGame, now: number): TubeView => ({ id: g.id, playing: !!g.id && g.playing, pos: tubePos(g, now), by: g.by?.name ?? null });

/** What a browser may send. */
export type TubeAction = { k: 'play'; link: string } | { k: 'pause' } | { k: 'resume' } | { k: 'seek'; t: number } | { k: 'stop' };
