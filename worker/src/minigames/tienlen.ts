import { newTienlen, tlDeal, tlJoin, tlLeave, tlPass, tlPlay, tlTick, tlView } from '../../../shared/minigames/tienlen';
import type { GameFactory } from './api';

/** Tiến lên, server side. Hands are secret, so every view goes to one person at a time and is never broadcast. */
export const create: GameFactory = (io) => {
  const g = newTienlen();
  const publish = (now: number) => {
    for (const p of io.players()) io.send(p.id, tlView(g, p.id, now));
  };
  /** Tell the room when a hand has just ended, however it ended. */
  const after = (was: string, now: number) => {
    if (was === 'play' && g.phase === 'ended' && g.winner) {
      io.notice(`${g.winner.name} won the hand of Tiến lên`);
      io.emote(g.winner.id, '🏆');
    }
    publish(now);
  };

  return {
    onAction(p, a, now) {
      const was = g.phase;
      let changed = false;
      if (a.k === 'join') changed = tlJoin(g, p);
      else if (a.k === 'leave') changed = tlLeave(g, p.id, now);
      else if (a.k === 'deal') changed = tlDeal(g, p.id, now);
      else if (a.k === 'pass') changed = tlPass(g, p.id, now);
      else if (a.k === 'play') {
        // tlPlay checks the cards themselves: shape, ownership, whose turn and whether they beat the table.
        const r = tlPlay(g, p.id, a.cards, now);
        changed = !!r;
        if (r === 'chop') io.emote(p.id, '💥');
      }
      if (changed) after(was, now);
    },
    onLeave(id, now) {
      const was = g.phase;
      if (tlLeave(g, id, now)) after(was, now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a table that someone is sitting at. They get no hand.
      if (g.players.length) io.send(p.id, tlView(g, p.id, now));
    },
    tick(now) {
      const was = g.phase;
      if (tlTick(g, now)) after(was, now);
    },
  };
};
