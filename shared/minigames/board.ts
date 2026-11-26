// Leaderboards: tallies of what people have done elsewhere in the room, kept by name.
// Rules only: no browser or server code in this file.

/** Names kept per table; past this the lowest is dropped. */
export const BOARD_CAP = 200;
export const NAME_MAX = 24;
/** Rows in the view everyone gets, and in the one sent on request. */
export const TOP_N = 5;
export const FULL_N = 20;
/** Changes are sent to everyone at most this often. */
export const FLUSH_MS = 1000;

export const TABLES = ['duel', 'goal', 'lap', 'chess', 'serve'] as const;
export type TableId = (typeof TABLES)[number];
export const TABLE_TITLES: Record<TableId, string> = {
  duel: 'Duels',
  goal: 'Goals scored',
  lap: 'Fastest lap',
  chess: 'Chess wins',
  serve: 'Dishes served',
};

export interface Tallies {
  duel: Map<string, { w: number; l: number }>;
  goal: Map<string, number>;
  /** Best lap per name, in milliseconds. */
  lap: Map<string, number>;
  chess: Map<string, number>;
  serve: Map<string, number>;
  /** Something changed since the last broadcast. */
  dirty: boolean;
  /** When the last broadcast went out (server clock). */
  sentAt: number;
}

export const newTallies = (): Tallies => ({
  duel: new Map(),
  goal: new Map(),
  lap: new Map(),
  chess: new Map(),
  serve: new Map(),
  dirty: false,
  sentAt: -Infinity,
});

/** The name a tally is kept under, or '' if it should not be counted. "Someone" is what the room calls a person it cannot name. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const n = raw.trim().slice(0, NAME_MAX).trim();
  return n === 'Someone' ? '' : n;
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** More wins first, then fewer losses, then name. */
const duelOrder = (a: [string, { w: number; l: number }], b: [string, { w: number; l: number }]) => b[1].w - a[1].w || a[1].l - b[1].l || byName(a[0], b[0]);
/** More first, then name. */
const countOrder = (a: [string, number], b: [string, number]) => b[1] - a[1] || byName(a[0], b[0]);
/** Quicker first, then name. */
const lapOrder = (a: [string, number], b: [string, number]) => a[1] - b[1] || byName(a[0], b[0]);

/** Keep a table to the cap by dropping the lowest. The name just counted is spared, or a full table could never take anyone new. */
function cap<V>(m: Map<string, V>, order: (a: [string, V], b: [string, V]) => number, keep: string) {
  while (m.size > BOARD_CAP) {
    const lowest = [...m].filter(([n]) => n !== keep).sort(order).pop();
    if (!lowest) return;
    m.delete(lowest[0]);
  }
}

function bump(m: Map<string, number>, name: string) {
  m.set(name, (m.get(name) ?? 0) + 1);
  cap(m, countOrder, name);
}

/** What the room reports. Loosely typed on purpose: every field is checked before it is counted. */
export interface BoardEvent {
  kind: string;
  winner?: unknown;
  loser?: unknown;
  by?: unknown;
  name?: unknown;
  ms?: unknown;
}

/** Count one thing that happened in the room. Returns true if a tally changed. */
export function boardApply(t: Tallies, e: BoardEvent): boolean {
  let changed = false;
  if (e.kind === 'duel') {
    const w = cleanName(e.winner);
    const l = cleanName(e.loser);
    // Nobody beats themselves; two people sharing a name would otherwise do exactly that.
    if (w && w === l) return false;
    for (const [name, won] of [[w, true], [l, false]] as const) {
      if (!name) continue;
      const r = t.duel.get(name) ?? { w: 0, l: 0 };
      if (won) r.w++;
      else r.l++;
      t.duel.set(name, r);
      cap(t.duel, duelOrder, name);
      changed = true;
    }
  } else if (e.kind === 'goal' || e.kind === 'chess' || e.kind === 'serve') {
    const name = cleanName(e.kind === 'goal' ? e.by : e.kind === 'chess' ? e.winner : e.name);
    if (name) {
      bump(t[e.kind], name);
      changed = true;
    }
  } else if (e.kind === 'lap') {
    const name = cleanName(e.name);
    const ms = e.ms;
    if (name && typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      const best = t.lap.get(name);
      if (best === undefined || ms < best) {
        t.lap.set(name, ms);
        cap(t.lap, lapOrder, name);
        changed = true;
      }
    }
  }
  if (changed) t.dirty = true;
  return changed;
}

/** Whether it is time to tell everyone: something changed, and the last broadcast was long enough ago. Marks it sent. */
export function boardFlush(t: Tallies, now: number): boolean {
  if (!t.dirty || now - t.sentAt < FLUSH_MS) return false;
  t.dirty = false;
  t.sentAt = now;
  return true;
}

/** What browsers get: the top `n` rows of each table, best first. */
export interface BoardView {
  /** How many rows per table were asked for (5 for everyone, 20 on request). */
  n: number;
  duel: { name: string; w: number; l: number }[];
  goal: { name: string; n: number }[];
  lap: { name: string; ms: number }[];
  chess: { name: string; n: number }[];
  serve: { name: string; n: number }[];
}

export function boardView(t: Tallies, n: number = TOP_N): BoardView {
  const counts = (m: Map<string, number>) => [...m].sort(countOrder).slice(0, n).map(([name, c]) => ({ name, n: c }));
  return {
    n,
    duel: [...t.duel].sort(duelOrder).slice(0, n).map(([name, r]) => ({ name, w: r.w, l: r.l })),
    goal: counts(t.goal),
    lap: [...t.lap].sort(lapOrder).slice(0, n).map(([name, ms]) => ({ name, ms })),
    chess: counts(t.chess),
    serve: counts(t.serve),
  };
}

/** A lap time as seconds with two decimals, e.g. "12.34 s". */
export const lapText = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

/** One table of a view as [name, score] pairs ready to show. */
export function boardRows(v: BoardView, id: TableId): { name: string; score: string }[] {
  if (id === 'duel') return v.duel.map((r) => ({ name: r.name, score: `${r.w} W · ${r.l} L` }));
  if (id === 'lap') return v.lap.map((r) => ({ name: r.name, score: lapText(r.ms) }));
  return v[id].map((r) => ({ name: r.name, score: String(r.n) }));
}

/** What a browser may send. Nothing a browser sends changes a tally. */
export type BoardAction = { k: 'full' };
