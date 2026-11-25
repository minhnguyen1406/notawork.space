import { baucuaBet, baucuaClear, baucuaGone, baucuaJoin, baucuaLeave, baucuaTick, baucuaView, newBauCua } from '../../../shared/minigames/baucua';
import type { GameFactory } from './api';

/** Bầu cua, server side. Bets are placed in the open, so every change goes to everyone. */
export const create: GameFactory = (io) => {
  const g = newBauCua();
  const publish = (now: number) => io.broadcast(baucuaView(g, now));

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = baucuaJoin(g, p, now);
      else if (a.k === 'leave') changed = baucuaLeave(g, p.id);
      else if (a.k === 'bet') changed = baucuaBet(g, p.id, a.sym, a.chip, now);
      else if (a.k === 'clear') changed = baucuaClear(g, p.id);
      if (changed) publish(now);
    },
    onLeave(id, now) {
      // Leaving the room forgets their chips as well as their seat.
      if (baucuaGone(g, id)) publish(now);
    },
    onJoin(p, now) {
      if (g.players.length) io.send(p.id, baucuaView(g, now));
    },
    tick(now) {
      const what = baucuaTick(g, now);
      if (!what) return;
      if (what === 'roll') for (const p of g.players) if (p.net !== null && p.net > 0) io.emote(p.id, '🎉');
      publish(now);
    },
  };
};
