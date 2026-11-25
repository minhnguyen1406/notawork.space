import { IT_SPEED, TAG_MAX, TAG_MIN, tagClock, type TagAction, type TagView } from '../../shared/minigames/tag';
import type { ClientGame, GameCtx } from './api';
import './tag.css';

const BADGE = '🔥';
let ctx: GameCtx;
let view: TagView | null = null;
/** When the current view arrived, to run its clocks locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** What this game has done to my walking, so it undoes only its own changes. */
let fast = false;
let frozen = false;
let frozenUntil = 0;
/** Who is wearing the badge at the moment. */
let badged: string | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = on;
  return b;
};
const send = (a: TagAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
const avatar = (id: string) => (id === ctx.myId() ? ctx.me() : null) ?? ctx.avatars.get(id) ?? null;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
/** Time left on the countdown or the game, counted down locally since the last view. */
const left = () => (view ? Math.max(0, view.left - (performance.now() - viewAt)) : 0);
/** My time as "it" so far, including the stretch since the last view if I am "it" now. */
function myTime(): number {
  const mine = view?.players.find((p) => p.id === ctx.myId());
  if (!view || !mine) return 0;
  return mine.itMs + (view.phase === 'play' && view.it === mine.id ? Math.min(view.left, performance.now() - viewAt) : 0);
}

function setFrozen(on: boolean) {
  if (frozen === on) return;
  frozen = on;
  ctx.freeze(on);
}
function setFast(on: boolean) {
  if (fast === on) return;
  fast = on;
  ctx.speed(on ? IT_SPEED : 1);
}
/** Move the badge to whoever is "it" (or take it away). Cheap enough to call every frame. */
function badge() {
  const want = view?.phase === 'play' ? view.it : null;
  if (badged && badged !== want) avatar(badged)?.setBadge(null);
  badged = want;
  // Every frame, because a character can appear after the view did.
  if (want) avatar(want)?.setBadge(BADGE);
}
/** Speed and rooting follow the server's view, and only while I am actually playing. */
function walking() {
  const me = ctx.myId();
  const playing = !!view && view.phase === 'play' && inGame();
  setFast(playing && view!.it === me);
  if (playing && view!.root === me && view!.rootLeft > 0) {
    frozenUntil = performance.now() + view!.rootLeft;
    setFrozen(true);
  } else setFrozen(false);
}

function close() {
  open = false;
  if (inGame()) send({ k: 'leave' });
  render();
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  const v: TagView = view ?? { players: [], phase: 'lobby', it: null, left: 0, root: null, rootLeft: 0, safe: null, results: null, winners: [] };
  const me = ctx.myId();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const live = v.phase !== 'lobby';
  p.className = `mg mg-card mg-tag${live ? ' mg-tag-live' : ''}`;

  if (live) {
    // One slim line while the game runs, so the room stays visible.
    const line = el('div', 'mg-tag-line');
    const who = v.phase === 'countdown' ? 'Get ready…' : v.it === me ? `${BADGE} You are it! Tag someone` : `${BADGE} ${name(v.it)} is it`;
    line.append(el('span', `mg-tag-who${v.it === me ? ' me' : ''}`, who), el('span', 'mg-tag-clock'));
    if (inGame()) line.append(el('span', 'mg-tag-mine mg-muted'), button('Leave', close, 'mg-tag-small'));
    else line.append(el('span', 'mg-muted', 'Join the next round'), button('Close', close, 'mg-tag-small'));
    p.replaceChildren(line);
    p.hidden = false;
    clock();
    return;
  }

  const chips = el('div', 'mg-players');
  for (const pl of v.players) chips.append(el('span', `mg-chip${pl.id === me ? ' me' : ''}`, pl.name));
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  const body: HTMLElement[] = [];
  if (v.results?.length) {
    const list = el('ol', 'mg-tag-rank');
    for (const r of v.results) {
      const won = v.winners.includes(r.id);
      const li = el('li', `${won ? 'win' : ''}${r.id === me ? ' me' : ''}`.trim());
      li.append(el('span', '', `${won ? '🏆 ' : ''}${r.name}`), el('span', 'mg-muted', `it for ${secs(r.itMs)}`));
      list.append(li);
    }
    body.push(el('p', 'mg-muted', 'Last game: least time as "it" wins'), list);
  }
  const need = v.players.length < TAG_MIN;
  body.push(el('p', 'mg-status', need ? `Needs ${TAG_MIN} or more to play (up to ${TAG_MAX}).` : 'Two minutes. Whoever is "it" the least wins.'));
  if (!v.results?.length) body.push(el('p', 'mg-muted', 'Get within arm\'s reach to pass "it" on. Sitting down takes you out.'));

  const row = el('div', 'mg-row');
  if (inGame()) {
    const start = button('Start', () => send({ k: 'start' }), 'primary');
    start.disabled = need;
    row.append(start, button('Leave', () => send({ k: 'leave' })));
  } else {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = v.players.length >= TAG_MAX;
    row.append(join);
  }
  p.replaceChildren(button('Close', close, 'mg-close'), el('h2', '', 'Tag'), chips, ...body, row);
  p.hidden = false;
}

/** Update the running numbers in the slim line without rebuilding it. */
function clock() {
  if (!view || view.phase === 'lobby' || ctx.panel.hidden) return;
  const c = ctx.panel.querySelector<HTMLElement>('.mg-tag-clock');
  if (c) {
    const text = view.phase === 'countdown' ? String(Math.max(1, Math.ceil(left() / 1000))) : tagClock(left());
    if (c.textContent !== text) c.textContent = text;
  }
  const m = ctx.panel.querySelector<HTMLElement>('.mg-tag-mine');
  if (m) {
    const text = `You: ${secs(myTime())}`;
    if (m.textContent !== text) m.textContent = text;
  }
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    const was = inGame();
    view = v as TagView;
    viewAt = performance.now();
    const me = ctx.myId();
    // Removed by the server (sat down): don't leave an empty panel behind unless I opened it at the signpost.
    if (was && !inGame() && view.phase !== 'lobby') open = false;
    if (view.phase === 'play' && before?.phase === 'play' && before.it && view.it && before.it !== view.it && view.safe === before.it) {
      // A tag: the tagger swipes, and the two people involved hear it.
      avatar(before.it)?.act('attack-melee-right', 500);
      if (view.it === me || before.it === me) ctx.play('pop');
      if (view.it === me) ctx.toast('Tagged! You are it.');
    } else if (view.phase === 'play' && before?.phase !== 'play' && inGame()) {
      ctx.play('horn');
      if (view.it === me) ctx.toast('You are it!');
    } else if (view.phase === 'play' && view.it === me && before?.it !== me) ctx.toast('You are it now!');
    if (view.phase === 'lobby' && before?.phase === 'play' && view.results && was && view.winners.includes(me)) {
      ctx.play('tada');
      ctx.confetti();
    }
    walking();
    badge();
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (frozen && performance.now() >= frozenUntil) setFrozen(false);
    badge();
    clock();
  },
  key(code) {
    // Only Escape, and only for an onlooker's panel: players need every key for running.
    if (code === 'Escape' && !ctx.panel.hidden && !inGame()) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    open = false;
    setFast(false);
    setFrozen(false);
    badge();
    render();
  },
};
