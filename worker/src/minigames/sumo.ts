import { GAME_ZONES } from '../../../shared/minigames';
import { type Mover, type SumoEvent, newSumo, sumoJoin, sumoLeave, sumoOutside, sumoPlaces, sumoPushes, sumoStart, sumoTick, sumoView } from '../../../shared/minigames/sumo';
import type { PlayerInfo } from '../../../shared/protocol';
import type { GameFactory } from './api';

/** Sumo ring, server side: referees the rounds and does the pushing from real positions. */
export const create: GameFactory = (io) => {
  const g = newSumo();
  const ring = GAME_ZONES.sumo;
  /** Where each wrestler was on the last tick, to tell who is charging. */
  let prev = new Map<string, { x: number; z: number }>();
  /** Who was pushed on the last tick, so a shove their browser has not answered yet is not repeated. */
  let pushed = new Set<string>();
  const publish = (now: number) => io.broadcast(sumoView(g, now));
  const nameOf = (id: string | null) => g.players.find((p) => p.id === id)?.name ?? 'Someone';

  /** Act on what the rules say happened. */
  function handle(ev: SumoEvent[], all: Map<string, PlayerInfo>) {
    for (const e of ev) {
      if (e.k === 'place') {
        const spots = sumoPlaces(g.alive.length, ring);
        g.alive.forEach((id, i) => {
          // Someone sitting down is out the moment the countdown ticks: leave them in their seat.
          if (all.get(id)?.seat === null) io.put(id, spots[i].x, spots[i].z);
        });
        prev = new Map();
        pushed = new Set();
      } else if (e.k === 'out') {
        io.emote(e.id, '💥');
        const p = all.get(e.id);
        // Someone who sat down stays in their seat; someone pushed out is stood clear of the ring.
        if (p && !p.seat) {
          const s = sumoOutside(p.x, p.z, ring);
          io.put(e.id, s.x, s.z);
        }
      } else if (e.k === 'round') {
        if (e.id) io.emote(e.id, '💪');
      } else if (e.k === 'match') {
        io.emote(e.id, '🏆');
        io.notice(`${e.name} won the sumo match`);
      } else if (e.k === 'abandon') io.notice(e.idle ? 'The sumo match was called off: nobody is wrestling' : 'The sumo match was called off: not enough wrestlers left');
    }
  }
  const everyone = () => new Map(io.players().map((p) => [p.id, p]));

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = sumoJoin(g, p);
      else if (a.k === 'leave') {
        const ev = sumoLeave(g, p.id, now);
        if (ev) handle(ev, everyone());
        changed = !!ev;
      } else if (a.k === 'start') {
        const ev = sumoStart(g, p.id, now);
        handle(ev, everyone());
        changed = ev.length > 0;
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      const ev = sumoLeave(g, id, now);
      if (!ev) return;
      handle(ev, everyone());
      publish(now);
    },
    onJoin(p, now) {
      if (g.players.length) io.send(p.id, sumoView(g, now));
    },
    tick(now) {
      if (g.phase === 'lobby') return;
      const all = everyone();
      const ev = sumoTick(g, now, (id) => all.get(id) ?? null, ring);
      handle(ev, all);
      if (ev.length) publish(now);
      if (g.phase !== 'countdown' && g.phase !== 'bout') return;

      const movers: Record<string, Mover> = {};
      const here = new Map<string, { x: number; z: number }>();
      for (const id of g.alive) {
        const p = all.get(id);
        // On the tick the bout starts, someone may be standing outside the ring: they are about to be
        // out, and are not shoved about wherever on the roof they are.
        if (!p || !(Math.hypot(p.x - ring.x, p.z - ring.z) <= ring.r)) continue;
        const was = prev.get(id) ?? p;
        movers[id] = { x: p.x, z: p.z, px: was.x, pz: was.z };
        here.set(id, { x: p.x, z: p.z });
      }
      const nowPushed = new Set<string>();
      if (g.phase === 'bout') {
        for (const [id, v] of Object.entries(sumoPushes(movers))) {
          const m = movers[id];
          // Pushed last tick and not moved since: that shove is still on its way, so wait for it.
          if (pushed.has(id) && m.x === m.px && m.z === m.pz) continue;
          io.nudge(id, v.dx, v.dz);
          nowPushed.add(id);
        }
      }
      prev = here;
      pushed = nowPushed;
    },
  };
};
