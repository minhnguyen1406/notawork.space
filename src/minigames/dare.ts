import { CHOOSE_MS, DARE_MIN, type DareAction, type DareView } from '../../shared/minigames/dare';
import type { ClientGame, GameCtx } from './api';
import './dare.css';

let ctx: GameCtx;
let view: DareView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;

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
const send = (a: DareAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-card mg-dare';
  const v: DareView = view ?? { players: [], phase: 'lobby', picked: null, kind: null, prompt: null, left: 0 };
  const me = ctx.myId();
  const name = (id: string | null) => v.players.find((x) => x.id === id)?.name ?? 'Someone';

  const chips = el('div', 'mg-players');
  for (const pl of v.players) chips.append(el('span', `mg-chip${pl.id === me ? ' me' : ''}${pl.id === v.picked ? ' turn' : ''}`, pl.name));
  if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));

  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');
  if (v.phase === 'choose') {
    const mine = v.picked === me;
    body.push(el('p', 'mg-status', mine ? 'The wheel picked you! Truth or dare?' : `The wheel picked ${name(v.picked)}. They are choosing…`));
    if (mine) row.append(button('Truth', () => send({ k: 'choose', kind: 'truth' }), 'primary'), button('Dare', () => send({ k: 'choose', kind: 'dare' }), 'primary'));
    const clock = el('div', 'mg-dare-clock');
    clock.append(el('i'));
    body.push(clock);
  } else if (v.phase === 'prompt') {
    body.push(el('p', 'mg-status', `${name(v.picked)} · ${v.kind === 'truth' ? 'Truth' : 'Dare'}`), el('p', 'mg-dare-prompt', v.prompt ?? ''));
  } else {
    body.push(el('p', 'mg-status', v.players.length < DARE_MIN ? `Needs ${DARE_MIN} or more to play.` : 'Spin to pick someone.'));
  }
  if (v.phase !== 'choose' && inGame()) {
    const spin = button(v.phase === 'prompt' ? 'Spin again' : 'Spin', () => send({ k: 'spin' }), 'primary');
    spin.disabled = v.players.length < DARE_MIN;
    row.append(spin);
  }
  row.append(inGame() ? button('Leave', () => send({ k: 'leave' })) : button('Join', () => send({ k: 'join' }), 'primary'));

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Truth or dare'), chips, ...body, row);
  p.hidden = false;
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as DareView;
    viewAt = performance.now();
    // A sound when the wheel lands on me, and when my prompt arrives.
    if (view.picked === ctx.myId() && view.phase === 'choose' && before?.phase !== 'choose') ctx.play('tada');
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    const bar = ctx.panel.querySelector<HTMLElement>('.mg-dare-clock i');
    if (bar && view?.phase === 'choose') bar.style.width = `${(Math.max(0, view.left - (performance.now() - viewAt)) / CHOOSE_MS) * 100}%`;
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
    render();
  },
};
