import { type CookResult, cookJoin, cookLeave, cookServe, cookStart, cookSwitch, cookTick, cookView, newCookoff, resultText } from '../../../shared/minigames/cookoff';
import type { GameFactory } from './api';

/** Cook-off, server side. It never touches the kitchen: it only hears about dishes through onEvent. */
export const create: GameFactory = (io) => {
  const g = newCookoff();
  const publish = (now: number) => io.broadcast(cookView(g, now));
  const announce = (r: CookResult | null | undefined) => {
    if (r) io.notice(resultText(r));
  };
  const left = (id: string, now: number) => {
    const out = cookLeave(g, id);
    if (!out) return;
    announce(out.ended);
    publish(now);
  };

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = cookJoin(g, p);
      else if (a.k === 'leave') return left(p.id, now);
      else if (a.k === 'switch') changed = cookSwitch(g, p.id);
      else if (a.k === 'start') {
        changed = cookStart(g, p.id, now);
        if (changed) io.notice(`${p.name} started a cook-off: three minutes, Red against Blue`);
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      left(id, now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a contest that someone has signed up for.
      if (g.players.length) io.send(p.id, cookView(g, now));
    },
    tick(now) {
      const t = cookTick(g, now);
      announce(t.ended);
      if (t.changed) publish(now);
    },
    onEvent(e, now) {
      if (e.kind !== 'serve') return;
      const s = cookServe(g, e.id, e.dish, now);
      if (!s) return;
      if (s.bonus) io.emote(e.id, '⭐');
      publish(now);
    },
  };
};
