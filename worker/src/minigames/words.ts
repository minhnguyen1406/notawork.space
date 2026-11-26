import {
  newWords, wordsClue, wordsEndTurn, wordsGuess, wordsJoin, wordsLeave, wordsStart, wordsSwitch, wordsTick, wordsView, wordsVolunteer,
} from '../../../shared/minigames/words';
import type { GameFactory } from './api';

/** Word clues, server side. The map of which word is whose is secret: it only ever goes to the two clue-givers. */
export const create: GameFactory = (io) => {
  const g = newWords();

  /** Everyone gets the public view; then each clue-giver gets their own copy with the map in it. */
  const publish = (now: number) => {
    io.broadcast(wordsView(g, now));
    if (g.phase === 'lobby') return;
    for (const p of g.players) if (p.giver) io.send(p.id, wordsView(g, now, p.id));
  };
  /** Publish a change, announcing the result if it ended the game. */
  const changed = (wasPlaying: boolean, now: number, timedOut = false) => {
    if (wasPlaying && g.phase === 'lobby' && g.result) {
      const { winner, reason } = g.result;
      if (!winner) io.notice(timedOut ? 'Word clues stopped: nobody was playing' : 'Word clues stopped: a team ran short of players');
      else io.notice(`${winner === 'red' ? 'Red' : 'Blue'} team won at word clues${reason === 'trap' ? ' (the other team hit the trap)' : ''}`);
    }
    publish(now);
  };

  return {
    onAction(p, a, now) {
      const playing = g.phase !== 'lobby';
      let ok = false;
      // Every rule function checks for itself who is asking, whose turn it is and what they sent.
      if (a.k === 'join') ok = wordsJoin(g, p);
      else if (a.k === 'leave') ok = wordsLeave(g, p.id);
      else if (a.k === 'switch') ok = wordsSwitch(g, p.id);
      else if (a.k === 'giver') ok = wordsVolunteer(g, p.id);
      else if (a.k === 'start') ok = wordsStart(g, p.id, now);
      else if (a.k === 'clue') ok = wordsClue(g, p.id, a.word, a.n, now);
      else if (a.k === 'guess') ok = wordsGuess(g, p.id, a.i, now) !== null;
      else if (a.k === 'end') ok = wordsEndTurn(g, p.id, now);
      if (ok) changed(playing, now);
    },
    onLeave(id, now) {
      const playing = g.phase !== 'lobby';
      if (wordsLeave(g, id)) changed(playing, now);
    },
    onJoin(p, now) {
      // A newcomer is never a clue-giver, so the public view is all they get.
      if (g.players.length) io.send(p.id, wordsView(g, now));
    },
    tick(now) {
      // A tick can end the game too: one that everyone has walked away from is abandoned.
      const playing = g.phase !== 'lobby';
      if (wordsTick(g, now)) changed(playing, now, true);
    },
  };
};
