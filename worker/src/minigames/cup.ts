import { cupGoal, cupJoin, cupKickoff, cupLeave, cupShuffle, cupSpots, cupSummary, cupSwitch, cupTick, cupView, newCup } from '../../../shared/minigames/cup';
import type { GameFactory } from './api';

/** Football match, server side. It uses the room's own ball and scoreboard; nothing is secret. */
export const create: GameFactory = (io) => {
  const g = newCup();
  const publish = (now: number) => io.broadcast(cupView(g, now));
  /** Ball on the spot and everyone back in their own half. */
  const lineUp = () => {
    io.resetBall();
    for (const s of cupSpots(g)) io.put(s.id, s.x, s.z);
  };
  const fullTime = () => {
    if (g.result) io.notice(cupSummary(g.result));
  };

  return {
    onAction(p, a, now) {
      let changed = false;
      if (a.k === 'join') {
        changed = cupJoin(g, p);
        // Arriving mid-match: start from a place in their own half.
        const spot = changed && g.phase !== 'lobby' && cupSpots(g).find((s) => s.id === p.id);
        if (spot) io.put(p.id, spot.x, spot.z);
      } else if (a.k === 'leave') {
        const r = cupLeave(g, p.id);
        changed = !!r;
        if (r === 'final') fullTime();
      } else if (a.k === 'switch') changed = cupSwitch(g, p.id);
      else if (a.k === 'shuffle') changed = cupShuffle(g, p.id);
      else if (a.k === 'kickoff') {
        changed = cupKickoff(g, p.id, now);
        if (changed) {
          io.setScore(0, 0);
          lineUp();
          io.notice(`${p.name} called a football match: Red against Blue, four minutes.`);
        }
      }
      if (changed) publish(now);
    },
    onLeave(id, now) {
      const r = cupLeave(g, id);
      if (r === 'final') fullTime();
      if (r) publish(now);
    },
    onJoin(p, now) {
      // A newcomer only needs to hear about a game that is actually going.
      if (g.players.length) io.send(p.id, cupView(g, now));
    },
    tick(now) {
      const r = cupTick(g, now);
      if (!r) return;
      if (r === 'extra') io.notice('Level at full time: one more minute, next goal wins!');
      if (r === 'final') fullTime();
      publish(now);
    },
    onEvent(e, now) {
      if (e.kind !== 'goal' || g.phase === 'lobby') return;
      const r = cupGoal(g, e.side, e.by, now);
      // The room has already added this goal to the scoreboard. During a kick-off pause it does
      // not count, so put the board back to the real score.
      if (!r) io.setScore(g.score[0], g.score[1]);
      else if (r === 'final') fullTime();
      else lineUp();
      publish(now);
    },
  };
};
