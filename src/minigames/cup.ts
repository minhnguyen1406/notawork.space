import { CUP_MIN, type CupAction, type CupPlayer, type CupView, type Side } from '../../shared/minigames/cup';
import type { ClientGame, GameCtx } from './api';
import './cup.css';

let ctx: GameCtx;
let view: CupView | null = null;
/** When the current view arrived, to run its clocks locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** Whether I have rooted myself, so it is undone exactly once. */
let frozen = false;
/** Whose heads carry a badge of mine, so only those are cleared. */
const badged = new Set<string>();
let sinceBadges = 0;

const BADGE: Record<Side, string> = { red: '🔴', blue: '🔵' };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
const button = (text: string, on: () => void, cls = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  // Never let a button keep the keyboard: Space must stay the room's key, not "press this again".
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = () => {
    b.blur();
    on();
  };
  return b;
};
const send = (a: CupAction) => ctx.send(a);
const mine = () => view?.players.find((p) => p.id === ctx.myId()) ?? null;
const inGame = () => !!mine();
const live = () => !!view && view.phase !== 'lobby';
const elapsed = () => performance.now() - viewAt;
const pauseLeft = () => (view?.phase === 'kickoff' ? Math.max(0, view.pause - elapsed()) : 0);
const clockLeft = () => (!view ? 0 : view.phase === 'play' ? Math.max(0, view.clock - elapsed()) : view.clock);
const mmss = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const cap = (s: Side) => (s === 'red' ? 'Red' : 'Blue');

/** Rooted during the kick-off pause, and never otherwise. */
function syncFreeze() {
  const want = inGame() && pauseLeft() > 0;
  if (want === frozen) return;
  frozen = want;
  ctx.freeze(want);
}

/** Team badges over heads while a match is on. Repeated now and then for characters that load late. */
function syncBadges() {
  const want = new Map<string, string>();
  if (view && live()) for (const p of view.players) want.set(p.id, BADGE[p.team]);
  for (const id of badged) {
    if (want.has(id)) continue;
    ctx.avatars.get(id)?.setBadge(null);
    badged.delete(id);
  }
  for (const [id, b] of want) {
    const a = ctx.avatars.get(id);
    if (!a) continue;
    a.setBadge(b);
    badged.add(id);
  }
}

function statusText(v: CupView): string {
  if (v.phase === 'kickoff') {
    const goal = v.last ? `${v.last.by} ${v.last.own ? 'put it in their own net' : `scored for ${cap(v.last.side)}`}! ` : '';
    return `${goal}Kick-off in ${Math.ceil(pauseLeft() / 1000)}…`;
  }
  if (v.phase === 'play') {
    const me = mine();
    const tip = me ? `You are ${cap(me.team)}: shoot at the ${me.team === 'red' ? 'east' : 'west'} goal.` : 'Match in progress.';
    return v.extra ? 'Next goal wins!' : tip;
  }
  if (v.players.length < CUP_MIN) return `Needs ${CUP_MIN} or more to play (1 a side).`;
  return 'Red defends the west goal, Blue the east. Four minutes.';
}

function resultText(v: CupView): string {
  const r = v.result;
  if (!r || v.phase !== 'lobby') return '';
  const top = r.top.length ? ` · Top scorer: ${r.top.join(' and ')} (${r.topGoals})` : '';
  return `Last match: Red ${r.score[0]} – ${r.score[1]} Blue, ${r.winner ? `${cap(r.winner)} won${r.forfeit ? ' by forfeit' : ''}` : 'a draw'}${top}`;
}

function teamList(v: CupView, side: Side) {
  const box = el('div', `mg-cup-team mg-cup-${side}`);
  const chips = el('div', 'mg-players');
  const team: CupPlayer[] = v.players.filter((p) => p.team === side);
  for (const p of team) {
    const goals = v.scorers.find((s) => s.name === p.name && s.team === side)?.goals ?? 0;
    chips.append(el('span', `mg-chip${p.id === ctx.myId() ? ' me' : ''}`, live() && goals ? `${p.name} ⚽${goals > 1 ? goals : ''}` : p.name));
  }
  if (!team.length) chips.append(el('span', 'mg-muted', 'Nobody yet'));
  box.append(el('b', '', `${BADGE[side]} ${cap(side)} (${team.length})`), chips);
  return box;
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  const v: CupView = view ?? { players: [], phase: 'lobby', extra: false, score: [0, 0], pause: 0, clock: 0, scorers: [], last: null, result: null };
  p.className = `mg mg-card mg-cup${live() ? ' mg-cup-live' : ''}`;

  const board = el('div', 'mg-cup-board');
  if (live()) board.append(el('span', 'mg-cup-score', `Red ${v.score[0]} – ${v.score[1]} Blue`), el('span', 'mg-cup-clock', mmss(clockLeft())));
  const teams = el('div', 'mg-cup-teams');
  teams.append(teamList(v, 'red'), teamList(v, 'blue'));

  const row = el('div', 'mg-row');
  if (!live() && inGame()) {
    const kick = button('Kick off', () => send({ k: 'kickoff' }), 'primary');
    const shuffle = button('Shuffle', () => send({ k: 'shuffle' }));
    kick.disabled = shuffle.disabled = v.players.length < CUP_MIN;
    const me = mine()!;
    const swap = button('Switch sides', () => send({ k: 'switch' }));
    // The server has the last word; this just greys the button when switching would unbalance the sides.
    const mineAfter = v.players.filter((x) => x.team === me.team).length - 1;
    swap.disabled = Math.abs(mineAfter - (v.players.length - mineAfter)) > 1;
    row.append(kick, swap, shuffle);
  }
  row.append(inGame() ? button('Leave', () => send({ k: 'leave' })) : button(live() ? 'Join in' : 'Join', () => send({ k: 'join' }), 'primary'));

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  const kids: HTMLElement[] = [close, el('h2', '', 'Football match'), board, el('p', 'mg-status', statusText(v)), teams];
  const last = resultText(v);
  if (last) kids.push(el('p', 'mg-muted mg-cup-last', last));
  kids.push(row);
  p.replaceChildren(...kids);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as CupView;
    viewAt = performance.now();
    const me = ctx.myId();
    // Only react to things that happened while I was watching, not to history sent on arrival.
    if (before) {
      if (view.phase === 'kickoff' && before.phase !== 'kickoff' && inGame()) ctx.play(before.phase === 'lobby' ? 'horn' : 'pop');
      const r = view.result;
      if (r && r.n !== before.result?.n && before.players.some((p) => p.id === me)) {
        ctx.play(r.winners.includes(me) ? 'tada' : 'horn');
        if (r.winners.includes(me)) ctx.confetti(['⚽', '🏆', '🎉', BADGE[r.winner ?? 'red']]);
      }
    }
    syncFreeze();
    syncBadges();
    render();
  },
  open() {
    open = true;
    render();
  },
  frame(dt) {
    syncFreeze();
    if ((sinceBadges += dt) > 0.5) {
      sinceBadges = 0;
      syncBadges();
    }
    if (ctx.panel.hidden || !view || !live()) return;
    const clock = ctx.panel.querySelector<HTMLElement>('.mg-cup-clock');
    const text = mmss(clockLeft());
    if (clock && clock.textContent !== text) clock.textContent = text;
    // The countdown is in the status line; keep its number moving between views.
    const status = ctx.panel.querySelector<HTMLElement>('.mg-status');
    const line = statusText(view);
    if (status && status.textContent !== line) status.textContent = line;
  },
  key(code) {
    // Only Escape, and only to close the panel for someone looking on. Everything else is the room's.
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
    syncFreeze();
    syncBadges();
    render();
  },
};
