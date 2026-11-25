import { newTag, tagJoin, tagLeave, tagStart, tagTick, tagView, type TagEvent } from '../../../shared/minigames/tag';
import type { GameFactory } from './api';

/** Tag, server side. Tags are decided here from real positions; browsers only join, leave and start. */
export const create: GameFactory = (io) => {
  const g = newTag();
  /** Names outlive the player list, so someone who just left can still be named. */
  const names = new Map<string, string>();
  const nameOf = (id: string) => names.get(id) ?? 'Someone';
  const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

  /** Announce what the rules say happened, then send everyone the new state. */
  const tell = (ev: TagEvent[], now: number) => {
    if (!ev.length) return;
    for (const e of ev) {
      if (e.k === 'go') {
        io.emote(e.it, '🔥');
        io.notice(`Tag: ${nameOf(e.it)} is it. Run!`);
      } else if (e.k === 'tag') {
        io.emote(e.to, '🔥');
        io.emote(e.from, '😅');
      } else if (e.k === 'it') {
        io.emote(e.id, '🔥');
        io.notice(`Tag: ${nameOf(e.id)} is it now.`);
      } else if (e.k === 'stop') {
        io.notice('Tag stopped: not enough players left.');
      } else if (e.k === 'end') {
        const who = e.winners.map(nameOf);
        const best = secs(e.results[0]?.itMs ?? 0);
        io.notice(who.length === 1 ? `${who[0]} won at tag (it for only ${best})` : `${who.join(' and ')} share the win at tag (it for ${best} each)`);
      }
    }
    io.broadcast(tagView(g, now));
  };

  return {
    onAction(p, a, now) {
      if (a.k === 'join') {
        // Seated players would be thrown out on the first tick, so don't let them in.
        if (p.seat === null && tagJoin(g, p)) {
          names.set(p.id, p.name);
          tell([{ k: 'join' }], now);
        }
      } else if (a.k === 'leave') tell(tagLeave(g, p.id, now), now);
      else if (a.k === 'start') {
        if (tagStart(g, p.id, now)) tell([{ k: 'countdown' }], now);
      }
    },
    onLeave(id, now) {
      tell(tagLeave(g, id, now), now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a game that is gathering or going, or a result to show.
      if (g.players.length || g.results) io.send(p.id, tagView(g, now));
    },
    tick(now) {
      if (g.phase === 'lobby') return;
      const here = io.players();
      const rooted = g.root;
      tell(tagTick(g, now, here), now);
      // The browser roots a tagged player itself; if one moves anyway, put them back.
      if (rooted && g.root === rooted) {
        const p = here.find((x) => x.id === rooted.id);
        if (p && Math.hypot(p.x - rooted.x, p.z - rooted.z) > 1.5) io.put(rooted.id, rooted.x, rooted.z);
      }
    },
  };
};
