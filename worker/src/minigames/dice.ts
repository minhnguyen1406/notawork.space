import { diceBid, diceJoin, diceLeave, diceLiar, diceStart, diceTick, diceView, diceViewFor, newDice } from '../../../shared/minigames/dice';
import type { GameFactory } from './api';

/** Liar's dice, server side. The public view goes to everyone; each player's own dice go only to them. */
export const create: GameFactory = (io) => {
  const g = newDice();
  let wasPlaying = false;

  const publish = (now: number) => {
    io.broadcast(diceView(g, now));
    // The private copy follows the public one, so a player's browser ends up holding their dice.
    if (g.phase === 'bid') for (const p of g.players) if (p.count > 0) io.send(p.id, diceViewFor(g, now, p.id));
    // A game that has just ended with someone still holding dice has a winner.
    if (wasPlaying && g.phase === 'lobby' && g.winner) io.notice(`${g.winner.name} won at liar's dice`);
    wasPlaying = g.phase !== 'lobby';
  };

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') changed = diceJoin(g, p);
      else if (a.k === 'leave') changed = diceLeave(g, p.id, now);
      else if (a.k === 'start') changed = diceStart(g, p.id, now);
      else if (a.k === 'bid') changed = diceBid(g, p.id, a.n, a.face, now);
      else if (a.k === 'liar') {
        changed = diceLiar(g, p.id, now);
        if (changed) io.emote(p.id, '🤥');
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      if (diceLeave(g, id, now)) publish(now);
    },
    onJoin(p, now) {
      // A newcomer is never a player (joining is only possible in the lobby), so the public view is all they get.
      if (g.players.length) io.send(p.id, diceView(g, now));
    },
    tick(now) {
      if (diceTick(g, now)) publish(now);
    },
  };
};
