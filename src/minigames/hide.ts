import { HIDE_MAX, HIDE_MIN, type HideAction, type HideView, hideSummary } from '../../shared/minigames/hide';
import type { ClientGame, GameCtx } from './api';
import './hide.css';

let ctx: GameCtx;
let view: HideView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** Whether this game is the one holding me still, so it never releases another game's freeze. */
let frozen = false;
/** Characters whose badge or name tag this game has changed, so all of them can be put back. */
const marked = new Set<string>();
/** Seconds since the badges and name tags were last checked against the view. */
let sinceMarks = 0;

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
const send = (a: HideAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
const playing = () => !!view && view.phase !== 'lobby';
/** Am I the seeker with my eyes covered right now? */
const blind = () => view?.phase === 'hiding' && view.seeker === ctx.myId();
const leftNow = () => (view ? Math.max(0, view.left - (performance.now() - viewAt)) : 0);
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Make badges and name tags match the view: 🔎 on the seeker, 👀 on anyone found, and no name
 * floating over anyone still hidden. Run again and again, because characters come and go.
 */
function decorate() {
  const want = new Map<string, { badge: string | null; hide: boolean }>();
  if (view && playing())
    for (const p of view.players) {
      if (p.id === view.seeker) want.set(p.id, { badge: '🔎', hide: false });
      else if (view.found.includes(p.id)) want.set(p.id, { badge: '👀', hide: false });
      else want.set(p.id, { badge: null, hide: true });
    }
  for (const id of marked) {
    if (want.has(id)) continue;
    const a = ctx.avatars.get(id);
    a?.setBadge(null);
    a?.setNameHidden(false);
    marked.delete(id);
  }
  let off = 0;
  for (const [id, w] of want) {
    const a = ctx.avatars.get(id);
    if (!a) continue;
    a.setBadge(w.badge);
    a.setNameHidden(w.hide);
    marked.add(id);
    if (w.hide) off++;
  }
  // For the browser test, which cannot see into the 3D scene.
  ctx.panel.dataset.tagsOff = String(off);
}

/** Root me while I count as the seeker, and let go the moment that stops being true. */
function hold() {
  const on = blind();
  if (on === frozen) return;
  frozen = on;
  ctx.freeze(on);
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-card mg-hide';
  const v: HideView = view ?? { players: [], phase: 'lobby', seeker: null, found: [], news: null, left: 0, result: null };
  const me = ctx.myId();
  const mine = inGame();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const hiders = v.players.filter((x) => x.id !== v.seeker);
  const hidden = hiders.filter((x) => !v.found.includes(x.id));

  const chips = el('div', 'mg-players');
  for (const pl of v.players) {
    const seeker = pl.id === v.seeker;
    const found = v.found.includes(pl.id);
    chips.append(el('span', `mg-chip${pl.id === me ? ' me' : ''}${seeker ? ' turn' : ''}${found ? ' mg-hide-found' : ''}`, `${seeker ? '🔎 ' : found ? '👀 ' : ''}${pl.name}`));
  }
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  if (v.phase === 'lobby') {
    if (v.result) body.push(el('p', 'mg-hide-result', hideSummary(v.result)));
    body.push(
      el('p', 'mg-status', v.players.length < HIDE_MIN ? `Needs ${HIDE_MIN} or more to play (up to ${HIDE_MAX}).` : 'Press Start: one of you is picked to seek, the rest get 30 seconds to hide.'),
    );
    if (mine) {
      const start = button(v.result ? 'Play again' : 'Start', () => send({ k: 'start' }), 'primary');
      start.disabled = v.players.length < HIDE_MIN;
      row.append(start);
    }
    row.append(mine ? button('Leave', () => send({ k: 'leave' })) : button('Join', () => send({ k: 'join' }), 'primary'));
  } else {
    let role: string;
    if (v.phase === 'hiding') {
      if (v.seeker === me) role = 'You are the seeker. No peeking!';
      else if (mine) role = `You are hiding. ${name(v.seeker)} can't see or move yet: run!`;
      else role = `${name(v.seeker)} is counting while the others hide.`;
    } else if (v.seeker === me) role = 'You are the seeker. Go and find them!';
    else if (!mine) role = `${name(v.seeker)} is seeking.`;
    else if (v.found.includes(me)) role = 'You were found. Watch the others squirm.';
    else role = `You are hidden. Stay more than two metres from ${name(v.seeker)}.`;
    body.push(el('p', 'mg-status', role));

    const facts = el('p', 'mg-hide-facts');
    facts.append(
      el('span', 'mg-hide-label', v.phase === 'hiding' ? 'Seeking starts in ' : 'Time left '),
      el('b', 'mg-hide-clock', clock(leftNow())),
      el('span', 'mg-hide-count', ` · ${hidden.length} of ${hiders.length} still hidden`),
    );
    body.push(facts);
    if (v.news) body.push(el('p', 'mg-hide-news', v.news));
    if (mine) row.append(button('Leave', () => send({ k: 'leave' })));
    else body.push(el('p', 'mg-muted', 'A round is going. You can join when it ends.'));
  }

  const parts: HTMLElement[] = [];
  // No Close button for someone in a round: closing leaves the game, and a stray click would end it for all.
  if (!(mine && playing()))
    parts.push(
      button('Close', () => {
        open = false;
        if (inGame()) send({ k: 'leave' });
        render();
      }, 'mg-close'),
    );
  parts.push(el('h2', '', 'Hide and seek'), chips, ...body, row);
  if (blind()) {
    // Covers the whole window, card included, so the seeker cannot watch where people go.
    const dark = el('div', 'mg-hide-blind');
    dark.append(el('h3', '', 'No peeking'), el('b', 'mg-hide-count-down', String(Math.ceil(leftNow() / 1000))), el('p', '', 'You are the seeker. Everyone else is hiding.'));
    parts.push(dark);
  }
  p.replaceChildren(...parts);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as HideView;
    viewAt = performance.now();
    const me = ctx.myId();
    const wasIn = !!before?.players.some((p) => p.id === me);
    if (inGame() && view.phase === 'hiding' && before?.phase !== 'hiding') ctx.play(view.seeker === me ? 'alarm' : 'horn');
    if (inGame() && view.phase === 'seeking' && before?.phase === 'hiding') ctx.play('horn');
    if (view.found.includes(me) && !before?.found.includes(me)) {
      ctx.play('pop');
      ctx.toast('You were found!');
    }
    // The round just ended: cheer if I was on the winning side.
    if (before && before.phase !== 'lobby' && view.phase === 'lobby' && view.result && wasIn) {
      const stayedHidden = before.seeker !== me && !before.found.includes(me);
      if (view.result.winner === 'seeker' ? before.seeker === me : view.result.winner === 'hiders' && stayedHidden) {
        ctx.confetti();
        ctx.play('tada');
      }
    }
    hold();
    decorate();
    render();
  },
  open() {
    open = true;
    render();
  },
  frame(dt) {
    if (!view) return;
    // Characters appear and are rebuilt after the view arrives, so keep the marks true.
    sinceMarks += dt;
    if (sinceMarks > 0.25 && (playing() || marked.size)) {
      sinceMarks = 0;
      decorate();
    }
    if (!playing() || ctx.panel.hidden) return;
    const left = leftNow();
    const c = ctx.panel.querySelector<HTMLElement>('.mg-hide-clock');
    if (c) c.textContent = clock(left);
    const d = ctx.panel.querySelector<HTMLElement>('.mg-hide-count-down');
    if (d) d.textContent = String(Math.ceil(left / 1000));
  },
  key(code) {
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
    hold();
    decorate();
    render();
  },
};
