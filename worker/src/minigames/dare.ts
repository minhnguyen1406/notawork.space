import { dareChoose, dareJoin, dareLeave, dareSpin, dareTick, dareView, newDare } from '../../../shared/minigames/dare';
import type { GameFactory } from './api';

/** Truth or dare, server side. Every change is sent to everyone, since nothing is secret. */
export const create: GameFactory = (io) => {
  const g = newDare();
  const publish = (now: number) => io.broadcast(dareView(g, now));
  const nameOf = (id: string | null) => g.players.find((p) => p.id === id)?.name ?? 'Someone';

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = dareJoin(g, p);
      else if (a.k === 'leave') changed = dareLeave(g, p.id);
      else if (a.k === 'spin') {
        changed = dareSpin(g, p.id, now);
        if (changed && g.picked) io.emote(g.picked, '🎯');
      } else if (a.k === 'choose') {
        changed = dareChoose(g, p.id, a.kind);
        if (changed) io.notice(`${nameOf(g.picked)} chose ${g.kind}`);
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      if (dareLeave(g, id)) publish(now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a game that is actually going.
      if (g.players.length) io.send(p.id, dareView(g, now));
    },
    tick(now) {
      if (dareTick(g, now)) publish(now);
    },
  };
};
