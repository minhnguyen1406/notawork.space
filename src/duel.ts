import * as THREE from 'three';
import { HEARTS, MOVES, MOVE_INFO, ROUND_MS, type DuelView, type Move } from '../shared/duel';
import type { ClientMsg } from '../shared/protocol';
import type { Avatar } from './avatar';
import { confetti, play } from './fun';

interface Shown {
  view: DuelView;
  /** When this view arrived, to count its clock down locally. */
  at: number;
  ring: THREE.Mesh;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const hearts = (n: number) => '♥'.repeat(n) + '♡'.repeat(Math.max(0, HEARTS - n));

/** Everything the browser does for duels: the ring and hearts in the room, and the fighter's panel. */
export class DuelUI {
  private shown = new Map<number, Shown>();
  private panel = document.getElementById('duel')!;
  private askEl = document.getElementById('duel-ask')!;
  private myPick: Move | null = null;
  private pickedRound = 0;

  constructor(
    private scene: THREE.Scene,
    private avatars: Map<string, Avatar>,
    private myId: () => string,
    private send: (m: ClientMsg) => void,
  ) {}

  /** The duel I am fighting in, if any (and it isn't finished). */
  mine(): DuelView | null {
    const me = this.myId();
    for (const s of this.shown.values()) if (s.view.phase !== 'over' && (s.view.a.id === me || s.view.b.id === me)) return s.view;
    return null;
  }
  /** True if this person is in a duel that is still going. */
  busy(id: string) {
    for (const s of this.shown.values()) if (s.view.phase !== 'over' && (s.view.a.id === id || s.view.b.id === id)) return true;
    return false;
  }

  // ------------------------------------------------------------ being challenged

  ask(from: string, name: string) {
    this.askEl.replaceChildren(
      el('p', '', `⚔️ ${name} challenges you to a duel`),
      this.button('Accept (Y)', 'primary', () => this.answer(true)),
      this.button('No thanks (N)', '', () => this.answer(false)),
    );
    this.askEl.hidden = false;
    this.askEl.dataset.from = from;
    play('pop');
    window.setTimeout(() => {
      if (this.askEl.dataset.from === from) this.askEl.hidden = true;
    }, 14_000);
  }
  get asking() {
    return !this.askEl.hidden;
  }
  answer(yes: boolean) {
    if (this.askEl.hidden) return;
    this.askEl.hidden = true;
    this.askEl.dataset.from = '';
    this.send({ t: 'duel', a: yes ? 'accept' : 'decline' });
  }

  private button(text: string, cls: string, on: () => void) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.onclick = on;
    return b;
  }

  // ------------------------------------------------------------ news from the server

  clear() {
    for (const id of [...this.shown.keys()]) this.remove(id);
    this.askEl.hidden = true;
    this.render();
  }

  private remove(id: number) {
    const s = this.shown.get(id);
    if (!s) return;
    s.ring.removeFromParent();
    s.ring.geometry.dispose();
    (s.ring.material as THREE.Material).dispose();
    for (const f of [s.view.a, s.view.b]) this.avatars.get(f.id)?.setHearts(null);
    this.shown.delete(id);
  }

  update(view: DuelView | null, id?: number) {
    if (!view) {
      if (id !== undefined) this.remove(id);
      this.render();
      return;
    }
    const before = this.shown.get(view.id);
    let ring = before?.ring;
    if (!ring) {
      ring = new THREE.Mesh(
        new THREE.RingGeometry(0.93, 1, 64),
        new THREE.MeshBasicMaterial({ color: '#ffb347', transparent: true, opacity: 0.9, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.userData.walkThrough = true;
      this.scene.add(ring);
      play('tada');
    }
    this.shown.set(view.id, { view, at: performance.now(), ring });
    const a = this.avatars.get(view.a.id);
    const b = this.avatars.get(view.b.id);
    a?.setHearts(view.a.hearts);
    b?.setHearts(view.b.hearts);

    const mine = view.a.id === this.myId() || view.b.id === this.myId();
    const fresh = !before || before.view.phase !== view.phase || before.view.round !== view.round;
    if (fresh && view.last && (view.phase === 'reveal' || view.phase === 'over')) {
      // Both moves are out: play them, and stagger whoever lost the round.
      const acts: Record<Move, string> = { pillow: 'attack-melee-right', chicken: 'interact-right', umbrella: 'holding-both' };
      for (const [av, move, fighter] of [[a, view.last.a, view.a], [b, view.last.b, view.b]] as const) {
        if (!av) continue;
        av.emote(move ? MOVE_INFO[move].icon : '💤');
        if (move) av.act(acts[move], 900);
        if (view.last.loser === fighter.id) window.setTimeout(() => av.act('emote-no', 900), 700);
      }
      if (mine) play(view.last.loser === this.myId() ? 'alarm' : view.last.loser ? 'pop' : 'pop');
    }
    if (fresh && view.phase === 'over') {
      const loser = view.winner === view.a.id ? b : view.winner === view.b.id ? a : null;
      const winner = view.winner === view.a.id ? a : view.winner === view.b.id ? b : null;
      window.setTimeout(() => {
        loser?.act('die', 2600);
        winner?.emote('dance');
        winner?.emote('🏆');
      }, 900);
      if (mine || this.near(a, b)) window.setTimeout(() => confetti(['⚔️', '🏆', '✨', '🎉']), 900);
    }
    if (mine && view.phase === 'pick' && view.round !== this.pickedRound) this.myPick = null;
    this.render();
  }

  private near(a?: Avatar, b?: Avatar) {
    const me = this.avatars.get(this.myId());
    const f = a ?? b;
    return !!me && !!f && Math.hypot(me.x - f.x, me.z - f.z) < 22;
  }

  // ------------------------------------------------------------ choosing a move

  /** Keys 1 to 3 while fighting. Returns true if the key was used. */
  key(n: number): boolean {
    const d = this.mine();
    if (!d || d.phase !== 'pick') return false;
    this.pick(MOVES[n - 1]);
    return true;
  }

  private pick(move: Move) {
    const d = this.mine();
    if (!d || d.phase !== 'pick' || this.myPick) return;
    this.myPick = move;
    this.pickedRound = d.round;
    this.send({ t: 'duel', a: 'pick', move });
    play('pop');
    this.render();
  }

  // ------------------------------------------------------------ drawing

  private render() {
    const d = this.mine() ?? this.lastOfMine();
    if (!d) {
      this.panel.hidden = true;
      return;
    }
    const me = d.a.id === this.myId() ? d.a : d.b;
    const them = d.a.id === this.myId() ? d.b : d.a;
    const myLast = d.last && (d.a.id === me.id ? d.last.a : d.last.b);
    const theirLast = d.last && (d.a.id === me.id ? d.last.b : d.last.a);
    const head = el('div', 'duel-head');
    head.append(el('span', 'duel-me', `You ${hearts(me.hearts)}`), el('span', 'duel-round', `Round ${d.round}`), el('span', 'duel-them', `${hearts(them.hearts)} ${them.name}`));

    let status = '';
    if (d.phase === 'pick') status = this.myPick ? `You chose ${MOVE_INFO[this.myPick].label}. Waiting for ${them.name}…` : `Pick a move${them.ready ? ` (${them.name} is ready)` : ''}`;
    else {
      const name = (m: Move | null | undefined) => (m ? `${MOVE_INFO[m].icon} ${MOVE_INFO[m].label}` : '💤 nothing');
      const result = !d.last?.loser ? 'A tie.' : d.last.loser === me.id ? 'You lose a heart.' : `${them.name} loses a heart.`;
      status = `${name(myLast)}  vs  ${name(theirLast)}. ${result}`;
      if (d.phase === 'over') status += d.winner === '' ? ' The duel is a draw.' : d.winner === me.id ? ' You win the duel! 🏆' : ` ${them.name} wins the duel.`;
    }
    const moves = el('div', 'duel-moves');
    MOVES.forEach((m, i) => {
      const info = MOVE_INFO[m];
      const b = el('button', `duel-move${this.myPick === m ? ' picked' : ''}`);
      b.type = 'button';
      b.disabled = d.phase !== 'pick' || !!this.myPick;
      b.append(el('span', 'duel-icon', info.icon), el('span', 'duel-name', `${i + 1} · ${info.label}`), el('span', 'duel-beats', `beats ${MOVE_INFO[info.beats].icon}`));
      b.onclick = () => this.pick(m);
      moves.append(b);
    });
    const bar = el('div', 'duel-clock');
    bar.append(el('i', ''));
    const quit = this.button('Give up', 'duel-quit', () => this.send({ t: 'duel', a: 'quit' }));
    quit.hidden = d.phase === 'over';
    this.panel.replaceChildren(head, el('p', 'duel-status', status), moves, bar, quit);
    this.panel.hidden = false;
  }

  /** A duel of mine that has just finished and is still on show. */
  private lastOfMine(): DuelView | null {
    const me = this.myId();
    for (const s of this.shown.values()) if (s.view.a.id === me || s.view.b.id === me) return s.view;
    return null;
  }

  /** Each frame: keep the ring round the fighters, turn them to face each other, run the clock. */
  frame() {
    const now = performance.now();
    for (const s of this.shown.values()) {
      const a = this.avatars.get(s.view.a.id);
      const b = this.avatars.get(s.view.b.id);
      if (!a || !b) continue;
      const r = Math.max(2.2, Math.hypot(a.x - b.x, a.z - b.z) / 2 + 1.4);
      s.ring.position.set((a.x + b.x) / 2, 0.05, (a.z + b.z) / 2);
      s.ring.scale.setScalar(r * (1 + Math.sin(now / 260) * 0.015));
      if (s.view.phase !== 'over') {
        a.faceTowards(b.x, b.z);
        b.faceTowards(a.x, a.z);
      }
    }
    const d = this.mine();
    const clock = this.panel.querySelector<HTMLElement>('.duel-clock i');
    if (d && clock) {
      const s = [...this.shown.values()].find((x) => x.view.id === d.id)!;
      const left = Math.max(0, s.view.left - (now - s.at));
      clock.style.width = d.phase === 'pick' ? `${(left / ROUND_MS) * 100}%` : '0%';
    }
  }
}
