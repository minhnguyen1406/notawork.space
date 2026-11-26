import { type HideEvents, hideJoin, hideLeave, hideStart, hideSummary, hideTick, hideView, newHide } from '../../../shared/minigames/hide';
import type { GameFactory } from './api';

/** How far the seeker may drift while counting before being put back (metres). */
const PEEK_LEASH = 1;

/** Hide and seek, server side. People are found from their real positions, never from what a browser says. */
export const create: GameFactory = (io) => {
  const g = newHide();
  /** Where the seeker stood when the round began: they stay there while the others hide. */
  let anchor: { x: number; z: number } | null = null;
  const publish = (now: number) => io.broadcast(hideView(g, now));
  /** Announce what a step of the rules did, and tell everyone. */
  const report = (ev: HideEvents, now: number) => {
    for (const id of ev.found) io.emote(id, '👀');
    if (ev.result) {
      anchor = null;
      io.notice(hideSummary(ev.result));
    }
    if (ev.changed) publish(now);
  };

  return {
    onAction(p, a, now) {
      if (a.k === 'join') {
        if (hideJoin(g, p)) publish(now);
      } else if (a.k === 'leave') report(hideLeave(g, p.id), now);
      else if (a.k === 'start' && hideStart(g, p.id, now)) {
        const s = io.players().find((x) => x.id === g.seeker);
        // No anchor is better than one that is not a place: the seeker would be "put back" to nowhere.
        anchor = s && Number.isFinite(s.x) && Number.isFinite(s.z) ? { x: s.x, z: s.z } : null;
        io.notice(`Hide and seek: ${s?.name ?? 'Someone'} is the seeker. Thirty seconds to hide!`);
        if (g.seeker) io.emote(g.seeker, '🔎');
        publish(now);
      }
    },
    onLeave(id, now) {
      report(hideLeave(g, id), now);
    },
    onJoin(p, now) {
      // A newcomer needs the round as it stands, to hide the right name tags; an empty lobby is not news.
      if (g.players.length) io.send(p.id, hideView(g, now));
    },
    tick(now) {
      if (g.phase === 'lobby') return;
      const all = io.players();
      // The browser roots the seeker while they count; this catches one that doesn't.
      if (g.phase === 'hiding' && anchor) {
        const s = all.find((x) => x.id === g.seeker);
        if (s && Math.hypot(s.x - anchor.x, s.z - anchor.z) > PEEK_LEASH) io.put(s.id, anchor.x, anchor.z);
      }
      report(hideTick(g, now, all), now);
    },
  };
};
