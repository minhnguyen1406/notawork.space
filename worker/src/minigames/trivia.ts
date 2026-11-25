import { triviaAnswer, triviaJoin, triviaLeave, triviaStart, triviaTick, triviaView, triviaWinners, newTrivia } from '../../../shared/minigames/trivia';
import type { GameFactory } from './api';

/** Trivia night, server side. The right answer stays here until the reveal. */
export const create: GameFactory = (io) => {
  const g = newTrivia();

  /** Everyone gets the public view; whoever has answered also gets a copy with their own choice in it. */
  const publish = (now: number) => {
    io.broadcast(triviaView(g, now));
    if (g.phase === 'question') for (const id of Object.keys(g.answers)) io.send(id, triviaView(g, now, id));
  };
  /** Publish a change, and announce the result if it just ended the game. */
  const changed = (before: string, now: number) => {
    if (g.phase === 'final' && before !== 'final') {
      const won = triviaWinners(g);
      for (const w of won) io.emote(w.id, '🏆');
      if (!won.length) io.notice('Trivia night ended with nobody on the board');
      else if (g.players.length === 1) io.notice(`${won[0].name} scored ${won[0].score} at trivia night`);
      else io.notice(`${won.map((w) => w.name).join(' and ')} won trivia night with ${won[0].score} points`);
    }
    publish(now);
  };

  return {
    onAction(p, a, now) {
      const before = g.phase;
      let ok = false;
      if (a.k === 'join') ok = triviaJoin(g, p);
      else if (a.k === 'leave') ok = triviaLeave(g, p.id, now);
      else if (a.k === 'start') {
        ok = triviaStart(g, p.id, now);
        if (ok) io.notice(`${p.name} started trivia night: join at the signpost to play from the next question`);
      } else if (a.k === 'answer') ok = triviaAnswer(g, p.id, a.choice, now);
      if (ok) changed(before, now);
    },
    onLeave(id, now) {
      const before = g.phase;
      if (triviaLeave(g, id, now)) changed(before, now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a game that people are in.
      if (g.players.length) io.send(p.id, triviaView(g, now));
    },
    tick(now) {
      const before = g.phase;
      if (triviaTick(g, now)) changed(before, now);
    },
  };
};
