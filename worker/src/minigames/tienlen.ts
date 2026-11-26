import { VARIANT_NAMES, newTienlen, tlDeal, tlJoin, tlLeave, tlPass, tlPlay, tlTick, tlVariant, tlView } from '../../../shared/minigames/tienlen';
import type { GameFactory } from './api';

/** Tiến lên, server side. Hands are secret, so every view goes to one person at a time and is never broadcast. */
export const create: GameFactory = (io) => {
  const g = newTienlen();
  /** The results already announced, so each hand is announced once however it ended. */
  let told: unknown = null;
  const publish = (now: number) => {
    if (g.phase === 'ended' && g.results !== told && g.winner) {
      told = g.results;
      const how = g.results?.[0]?.note?.startsWith('Tới trắng') ? ' outright (tới trắng)' : '';
      io.notice(`${g.winner.name} won the hand of Tiến lên ${VARIANT_NAMES[g.variant]}${how}`);
      // The winner may have gone out first and then left the room before the hand ended: nobody to put a trophy over.
      const winner = g.winner.id;
      if (io.players().some((p) => p.id === winner)) io.emote(winner, '🏆');
    }
    for (const p of io.players()) io.send(p.id, tlView(g, p.id, now));
  };

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = tlJoin(g, p);
      else if (a.k === 'leave') changed = tlLeave(g, p.id, now);
      else if (a.k === 'deal') changed = tlDeal(g, p.id, now);
      else if (a.k === 'variant') changed = tlVariant(g, p.id, a.v);
      else if (a.k === 'pass') changed = tlPass(g, p.id, now);
      else if (a.k === 'play') {
        // tlPlay checks the cards themselves: shape, ownership, whose turn and whether they beat the table.
        const r = tlPlay(g, p.id, a.cards, now);
        changed = !!r;
        if (r === 'chop') io.emote(p.id, '💥');
        else if (r === 'out') io.emote(p.id, '🙌');
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      if (tlLeave(g, id, now)) publish(now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a table that someone is sitting at. They get no hand.
      if (g.players.length) io.send(p.id, tlView(g, p.id, now));
    },
    tick(now) {
      if (tlTick(g, now)) publish(now);
    },
  };
};
