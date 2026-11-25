import { RECIPES } from '../../shared/kitchen';
import { COOKOFF_MIN, type CookoffAction, type CookoffView, TEAMS, TEAM_BADGE, TEAM_NAME, type Team, resultText } from '../../shared/minigames/cookoff';
import type { ClientGame, GameCtx } from './api';
import './cookoff.css';

let ctx: GameCtx;
let view: CookoffView | null = null;
/** When the current view arrived, to run its clocks locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are taking part. */
let open = false;
/** Everyone I have put a team badge on, so they can all be taken off again. */
const badged = new Set<string>();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = () => {
    // Drop the focus at once, or Space and Enter would press this button again while cooking.
    b.blur();
    on();
  };
  return b;
};
const send = (a: CookoffAction) => ctx.send(a);
const mine = () => view?.players.find((p) => p.id === ctx.myId()) ?? null;
const elapsed = () => performance.now() - viewAt;
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const recipe = (dish: string) => RECIPES.find((r) => r.name === dish)?.items.join(' + ') ?? '';
const avatar = (id: string) => ctx.avatars.get(id) ?? (id === ctx.myId() ? ctx.me() : null);

/** Team badges while a contest runs, none otherwise. Cheap enough to call every frame: setBadge ignores repeats. */
function badges() {
  const live = view && view.phase !== 'lobby' ? view.players : [];
  for (const id of badged) {
    if (live.some((p) => p.id === id)) continue;
    avatar(id)?.setBadge(null);
    badged.delete(id);
  }
  for (const p of live) {
    const a = avatar(p.id);
    if (!a) continue;
    a.setBadge(TEAM_BADGE[p.team]);
    badged.add(p.id);
  }
}

function teamBox(v: CookoffView, t: Team, live: boolean) {
  const me = ctx.myId();
  const box = el('div', `mg-cookoff-team mg-cookoff-${t}`);
  const head = el('div', 'mg-cookoff-head');
  head.append(el('span', '', `${TEAM_BADGE[t]} ${TEAM_NAME[t]}`));
  if (live) head.append(el('b', 'mg-cookoff-score', String(v.score[t])));
  box.append(head);
  const o = v.order[t];
  if (live && o) {
    const order = el('div', 'mg-cookoff-order');
    order.append(el('b', '', o.dish), el('span', 'mg-muted', ` ×2 = ${o.pts} · `));
    const left = el('span', 'mg-muted mg-cookoff-order-left', mmss(o.left));
    left.dataset.team = t;
    order.append(left);
    box.append(order, el('div', 'mg-muted', recipe(o.dish)));
  }
  const chips = el('div', 'mg-players');
  for (const p of v.players) if (p.team === t) chips.append(el('span', `mg-chip${p.id === me ? ' me' : ''}`, live && p.pts ? `${p.name} ${p.pts}` : p.name));
  if (!chips.childElementCount) chips.append(el('span', 'mg-muted', 'Nobody yet'));
  box.append(chips);
  return box;
}

function render() {
  const p = ctx.panel;
  const me = mine();
  if (!open && !me) {
    p.hidden = true;
    return;
  }
  const v: CookoffView = view ?? { players: [], phase: 'lobby', left: 0, score: { red: 0, blue: 0 }, order: { red: null, blue: null }, feed: [], last: null };
  const live = v.phase !== 'lobby';
  p.className = `mg mg-card mg-cookoff${live ? ' mg-cookoff-live' : ''}`;

  const teams = el('div', 'mg-cookoff-teams');
  teams.append(teamBox(v, 'red', live), teamBox(v, 'blue', live));

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  if (v.phase === 'countdown') {
    body.push(el('p', 'mg-status mg-cookoff-clock', `Starting in ${Math.ceil(v.left / 1000)}…`), teams);
  } else if (v.phase === 'play') {
    body.push(el('p', 'mg-cookoff-clock', mmss(v.left)), teams);
    const feed = v.feed.slice().reverse().map((s) => `${TEAM_BADGE[s.team]} ${s.name}: ${s.dish} +${s.pts}${s.bonus ? ' ⭐' : ''}`);
    body.push(el('p', 'mg-muted mg-cookoff-feed', feed.join('  ·  ') || 'Nothing served yet. Both sides share the one kitchen and its ingredients.'));
  } else {
    body.push(teams);
    if (v.last) body.push(el('p', 'mg-cookoff-result', resultText(v.last).replace(/^Cook-off: /, 'Last time: ')));
    body.push(el('p', 'mg-status', v.players.length < COOKOFF_MIN ? `Needs ${COOKOFF_MIN} or more to play (one a side); up to 20.` : 'Sides are set. Anyone can press Start.'));
    body.push(
      el(
        'p',
        'mg-muted',
        'Three minutes, Red against Blue, in the kitchen as it always works: take ingredients, chop (F), cook, plate and serve at the hatch. ' +
          'A dish of two ingredients scores 1, three scores 2, four or more scores 3. Each side has an order that scores double, swapped every 45 seconds. ' +
          'Both sides share the one kitchen and its ingredients, so be quick, or be in the way.',
      ),
    );
  }

  if (!me) row.append(button(live ? 'Join in' : 'Join', () => send({ k: 'join' }), 'primary'));
  else if (!live) {
    const start = button('Start', () => send({ k: 'start' }), 'primary');
    start.disabled = v.players.length < COOKOFF_MIN;
    const r = v.players.filter((x) => x.team === 'red').length;
    const b = v.players.length - r;
    const swap = button('Switch sides', () => send({ k: 'switch' }));
    // Mirrors the server's rule, which has the final say: the sides must stay within one of each other.
    swap.disabled = Math.abs((me.team === 'red' ? r - 1 : r + 1) - (me.team === 'red' ? b + 1 : b - 1)) > 1;
    row.append(start, swap, button('Leave', () => send({ k: 'leave' })));
  }

  // As in the other games, closing the panel while taking part means leaving; mid-contest it says so.
  const close = button(me && live ? 'Leave' : 'Close', () => {
    open = false;
    if (me) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Cook-off'), ...body, ...(row.childElementCount ? [row] : []));
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    const was = mine();
    view = v as CookoffView;
    viewAt = performance.now();
    const me = mine();
    if (me && before?.phase === 'countdown' && view.phase === 'play') ctx.play('horn');
    // A serve that counted for my side.
    if (me && view.phase === 'play' && before?.phase === 'play' && view.score[me.team] > before.score[me.team]) ctx.play('pop');
    // The contest just ended: confetti for the winning side.
    if (before && before.phase === 'play' && view.phase === 'lobby' && view.last) {
      const team = (me ?? was)?.team;
      if (team && view.last.winner === team) {
        ctx.confetti([TEAM_BADGE[team], '🍔', '🏆']);
        ctx.play('tada');
      }
    }
    badges();
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (!view || view.phase === 'lobby') return;
    // People can walk into view after the contest began, so keep the badges topped up.
    badges();
    if (ctx.panel.hidden) return;
    const set = (e: HTMLElement | null, text: string) => {
      if (e && e.textContent !== text) e.textContent = text;
    };
    const left = Math.max(0, view.left - elapsed());
    set(ctx.panel.querySelector<HTMLElement>('.mg-cookoff-clock'), view.phase === 'countdown' ? `Starting in ${Math.max(1, Math.ceil(left / 1000))}…` : mmss(left));
    for (const t of TEAMS) {
      const o = view.order[t];
      if (o) set(ctx.panel.querySelector<HTMLElement>(`.mg-cookoff-order-left[data-team="${t}"]`), mmss(Math.max(0, o.left - elapsed())));
    }
  },
  key(code) {
    // Only ever Escape, and only for an onlooker: walking, E and F must always reach the kitchen.
    if (code === 'Escape' && !ctx.panel.hidden && !mine()) {
      open = false;
      render();
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    open = false;
    badges();
    render();
  },
};
