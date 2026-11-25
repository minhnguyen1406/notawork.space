import { ASK_MS, DUEL_LEASH, DUEL_REACH, duelForfeit, duelPick, duelTick, duelView, newDuel, type Duel } from '../../shared/duel';
import type { PlayerInfo, ServerMsg } from '../../shared/protocol';

export interface DuelIO {
  player(id: string): PlayerInfo | undefined;
  /** Send to one person. */
  send(id: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
}

/** Challenges and duels in progress. The server decides everything; browsers only show it. */
export class Duels {
  private duels = new Map<number, Duel>();
  /** Open challenges, by the id of the person asked. */
  private asks = new Map<string, { from: string; until: number }>();
  private nextId = 1;

  constructor(private io: DuelIO) {}

  private of(pid: string) {
    for (const d of this.duels.values()) if (d.phase !== 'over' && (d.a.id === pid || d.b.id === pid)) return d;
    return null;
  }

  /** Everything a newcomer needs to see the duels already under way. */
  views(now: number) {
    return [...this.duels.values()].map((d) => duelView(d, now));
  }

  private publish(d: Duel, now: number) {
    this.io.broadcast({ t: 'duel', duel: duelView(d, now) });
  }

  handle(me: PlayerInfo, msg: { a?: unknown; to?: unknown; move?: unknown }, now: number) {
    if (msg.a === 'challenge' && typeof msg.to === 'string') {
      const them = this.io.player(msg.to);
      if (!them || them.id === me.id || me.seat || them.seat) return;
      if (this.of(me.id) || this.of(them.id) || this.asks.has(them.id)) return;
      if (Math.hypot(them.x - me.x, them.z - me.z) > DUEL_REACH) return;
      this.asks.set(them.id, { from: me.id, until: now + ASK_MS });
      this.io.send(them.id, { t: 'duelAsk', from: me.id, name: me.name });
      this.io.send(me.id, { t: 'notice', text: `You challenged ${them.name}. Waiting for an answer…` });
    } else if (msg.a === 'accept' || msg.a === 'decline') {
      const ask = this.asks.get(me.id);
      if (!ask) return;
      this.asks.delete(me.id);
      const them = this.io.player(ask.from);
      if (!them) return;
      if (msg.a === 'decline') {
        this.io.send(them.id, { t: 'notice', text: `${me.name} would rather not fight.` });
        return;
      }
      if (me.seat || them.seat || this.of(me.id) || this.of(them.id)) return;
      const d = newDuel(this.nextId++, them, me, now);
      this.duels.set(d.id, d);
      this.io.broadcast({ t: 'notice', text: `⚔️ ${them.name} and ${me.name} are duelling!` });
      this.publish(d, now);
    } else if (msg.a === 'pick') {
      const d = this.of(me.id);
      if (d && duelPick(d, me.id, msg.move)) {
        this.publish(d, now);
        this.step(d, now);
      }
    } else if (msg.a === 'quit') {
      this.left(me.id, now);
    }
  }

  /** Someone disconnected, sat down or gave up. */
  left(pid: string, now: number) {
    this.asks.delete(pid);
    for (const [asked, ask] of this.asks) if (ask.from === pid) this.asks.delete(asked);
    const d = this.of(pid);
    if (!d) return;
    duelForfeit(d, pid, now);
    this.finish(d, now);
  }

  private finish(d: Duel, now: number) {
    const name = (id: string) => (d.a.id === id ? d.a.name : d.b.name);
    const text = d.winner === '' ? `The duel between ${d.a.name} and ${d.b.name} ended in a draw` : `🏆 ${name(d.winner!)} won the duel against ${name(d.winner === d.a.id ? d.b.id : d.a.id)}`;
    this.publish(d, now);
    this.io.broadcast({ t: 'notice', text });
  }

  private step(d: Duel, now: number) {
    if (!duelTick(d, now)) return;
    if (d.phase === 'over') this.finish(d, now);
    else this.publish(d, now);
  }

  /** Called every server tick. */
  tick(now: number) {
    for (const [asked, ask] of this.asks) if (now > ask.until) this.asks.delete(asked);
    for (const d of this.duels.values()) {
      if (d.phase === 'over') {
        // Leave the result up for a moment, then clear the duel away.
        if (now > d.until + 2500) {
          this.duels.delete(d.id);
          this.io.broadcast({ t: 'duel', duel: null, id: d.id });
        }
        continue;
      }
      const a = this.io.player(d.a.id);
      const b = this.io.player(d.b.id);
      // Walking away from the fight, or sitting down, gives it up.
      if (!a || !b) this.left(a ? d.b.id : d.a.id, now);
      else if (a.seat || b.seat) this.left(a.seat ? a.id : b.id, now);
      else if (Math.hypot(a.x - b.x, a.z - b.z) > DUEL_LEASH) {
        // They drifted apart: nobody wins.
        d.phase = 'over';
        d.winner = '';
        d.until = now;
        this.finish(d, now);
      }
      else this.step(d, now);
    }
  }
}
