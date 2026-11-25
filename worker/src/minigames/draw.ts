import { type DrawMsg, drawClear, drawGuess, drawInk, drawJoin, drawLeave, drawStart, drawTick, drawUndo, drawView, drawWinners, newDraw } from '../../../shared/minigames/draw';
import type { GameFactory } from './api';

/** Draw and guess, server side. The public view and the strokes go to everyone; the word goes only to the drawer. */
export const create: GameFactory = (io) => {
  const g = newDraw();
  /** The last turn whose word was handed out, and the phase last published, to spot what just happened. */
  let toldTurn = 0;
  let lastPhase = g.phase;
  /** When each person last asked for the whole picture, so it can't be asked for in a flood. */
  const lastSync = new Map<string, number>();

  const send = (id: string, m: DrawMsg) => io.send(id, m);
  const cast = (m: DrawMsg) => io.broadcast(m);
  const picture = (): DrawMsg => ({ t: 'strokes', turn: g.turn, strokes: g.strokes });
  /** Everything one person needs to see the game as it stands. */
  const catchUp = (id: string, now: number) => {
    if (g.phase === 'turn' || g.phase === 'reveal') send(id, picture());
    if (g.phase === 'turn' && g.drawer === id && g.word) send(id, { t: 'word', turn: g.turn, word: g.word });
    send(id, drawView(g, now));
  };

  /** Call after any change to the rules' state. */
  const publish = (now: number) => {
    if (g.phase === 'turn' && g.turn !== toldTurn && g.drawer && g.word) {
      toldTurn = g.turn;
      cast(picture()); // a clean sheet for the new turn
      send(g.drawer, { t: 'word', turn: g.turn, word: g.word });
      io.emote(g.drawer, '✏️');
    }
    if (g.phase === 'final' && lastPhase !== 'final') {
      const top = drawWinners(g);
      const names = top.map((p) => p.name);
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} tied` : `${names[0] ?? 'Nobody'} won`;
      io.notice(`${who} at Draw and guess with ${top[0]?.score ?? 0} points`);
    }
    if (g.phase === 'lobby' && (lastPhase === 'turn' || lastPhase === 'reveal')) io.notice('Draw and guess stopped: not enough players left.');
    lastPhase = g.phase;
    cast(drawView(g, now));
  };

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') {
        changed = drawJoin(g, p);
        if (changed) catchUp(p.id, now);
      } else if (a.k === 'leave') changed = drawLeave(g, p.id, now);
      else if (a.k === 'start') changed = drawStart(g, p.id, now);
      else if (a.k === 'guess') {
        const r = drawGuess(g, p.id, a.text, now);
        if (r === 'right') io.emote(p.id, '🎉');
        changed = r !== 'no';
      } else if (a.k === 'draw') {
        // Strokes go out on their own, without the whole view, since they come many times a second.
        const ink = drawInk(g, p.id, a, now);
        if (ink) cast({ t: 'ink', turn: g.turn, ...ink });
      } else if (a.k === 'undo' || a.k === 'clear') {
        if (a.k === 'undo' ? drawUndo(g, p.id, now) : drawClear(g, p.id, now)) cast(picture());
      } else if (a.k === 'sync') {
        if (now - (lastSync.get(p.id) ?? 0) < 500) return;
        lastSync.set(p.id, now);
        catchUp(p.id, now);
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      lastSync.delete(id);
      if (drawLeave(g, id, now)) publish(now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a game that is actually going.
      if (g.players.length) catchUp(p.id, now);
    },
    tick(now) {
      if (drawTick(g, now)) publish(now);
    },
  };
};
