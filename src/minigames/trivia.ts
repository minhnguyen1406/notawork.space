// Types only: importing a value from the rules file would ship the answers to the browser.
import type { TriviaAction, TriviaView } from '../../shared/minigames/trivia';
import type { ClientGame, GameCtx } from './api';
import './trivia.css';

let ctx: GameCtx;
let view: TriviaView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** What I picked for which question, kept so a later public view does not unlock my buttons. */
let myPick: { round: number; choice: number } | null = null;

const EMPTY: TriviaView = { players: [], phase: 'lobby', round: 0, total: 10, category: null, question: null, options: [], playing: [], answered: [], left: 0, span: 0 };

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
const send = (a: TriviaAction) => ctx.send(a);
const inGame = () => !!view?.players.some((p) => p.id === ctx.myId());
/** May I answer the question that is open? */
const canAnswer = () => view?.phase === 'question' && view.playing.includes(ctx.myId());
const picked = () => (view && myPick?.round === view.round ? myPick.choice : null);

function pick(choice: number) {
  if (!view || !canAnswer() || picked() !== null) return;
  // Lock it in here at once; the server has the final say and the reveal shows what it recorded.
  myPick = { round: view.round, choice };
  send({ k: 'answer', choice });
  render();
}

function clock(slim: boolean) {
  const c = el('div', `mg-trivia-clock${slim ? ' slim' : ''}`);
  const bar = el('div', 'mg-trivia-bar');
  bar.append(el('i'));
  c.append(bar);
  if (!slim) c.append(el('b'));
  return c;
}

function board(v: TriviaView) {
  const me = ctx.myId();
  const list = el('ol', `mg-trivia-board${v.players.length <= 6 ? ' short' : ''}`);
  const sorted = [...v.players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    // People level on points share a place.
    const rank = sorted.findIndex((x) => x.score === p.score) + 1;
    const li = el('li', `${p.id === me ? 'me' : ''}${v.winners?.includes(p.id) ? ' win' : ''}`.trim());
    li.append(el('span', 'rank', `${i && sorted[i - 1].score === p.score ? '=' : rank}`), el('span', 'name', p.name));
    const gain = v.gained?.[p.id];
    if (gain) li.append(el('span', 'gain', `+${gain}`));
    li.append(el('span', 'score', String(p.score)));
    list.append(li);
  });
  return list;
}

function options(v: TriviaView) {
  const grid = el('div', 'mg-trivia-opts');
  const me = ctx.myId();
  const mine = v.phase === 'reveal' ? (v.picks?.[me] ?? null) : picked();
  v.options.forEach((text, i) => {
    const b = button('', () => pick(i), 'mg-trivia-opt');
    b.append(el('kbd', '', String(i + 1)), el('span', '', text));
    if (v.phase === 'reveal') {
      b.disabled = true;
      if (i === v.correct) b.classList.add('right');
      else if (i === mine) b.classList.add('wrong');
      const n = Object.values(v.picks ?? {}).filter((c) => c === i).length;
      if (n) b.append(el('em', '', `${n} chose`));
    } else {
      b.disabled = !canAnswer() || mine !== null;
      if (i === mine) b.classList.add('picked');
    }
    grid.append(b);
  });
  return grid;
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  p.className = 'mg mg-sheet mg-trivia';
  const v = view ?? EMPTY;
  const me = ctx.myId();
  const playing = inGame();
  const name = (id: string) => v.players.find((x) => x.id === id)?.name ?? 'Someone';
  const body: HTMLElement[] = [];
  const row = el('div', 'mg-row');

  if (v.phase === 'question' || v.phase === 'reveal') {
    body.push(el('p', 'mg-trivia-round', `Question ${v.round} of ${v.total} · ${v.category ?? ''}`), clock(v.phase === 'reveal'), el('p', 'mg-trivia-q', v.question ?? ''), options(v));
  }
  if (v.phase === 'question') {
    const count = `${v.answered.length} of ${v.playing.length} answered`;
    let status = `Watching. Join to play from the next question. ${count}.`;
    if (canAnswer()) status = picked() === null ? `Press 1 to 4 or click. Faster is worth more. ${count}.` : `Locked in. ${count}.`;
    else if (playing) status = `You play from the next question. ${count}.`;
    body.push(el('p', 'mg-status', status));
  } else if (v.phase === 'reveal') {
    const right = v.options[v.correct ?? -1] ?? '';
    let status = `The answer is ${right}.`;
    if (v.playing.includes(me)) status = v.picks?.[me] === undefined ? `Out of time. The answer is ${right}.` : v.gained?.[me] ? `Correct! +${v.gained[me]}` : `Not this time. The answer is ${right}.`;
    const got = Object.entries(v.gained ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    body.push(el('p', 'mg-status', status), el('p', 'mg-muted mg-trivia-got', got.length ? `Got it: ${got.map(([id, n]) => `${name(id)} +${n}`).join(', ')}` : 'Nobody got it.'), board(v));
  } else if (v.phase === 'final') {
    const won = v.players.filter((x) => v.winners?.includes(x.id));
    const line = !won.length ? 'Nobody scored this time.' : v.players.length === 1 ? `You finished with ${won[0].score} points.` : `🏆 ${won.map((x) => x.name).join(' and ')} ${won.length > 1 ? 'win' : 'wins'} with ${won[0].score} points!`;
    body.push(el('p', 'mg-trivia-final', line), el('p', 'mg-muted', 'Final ranking'), board(v));
  } else {
    body.push(el('p', 'mg-status', 'One player is enough for a practice round, and any number can play.'), el('p', 'mg-muted', 'Ten questions, 15 seconds each. One answer, no changing it, and faster right answers score more (500 to 1000).'));
    const chips = el('div', 'mg-players');
    for (const pl of v.players) chips.append(el('span', `mg-chip${pl.id === me ? ' me' : ''}`, pl.name));
    if (!v.players.length) chips.append(el('span', 'mg-muted', 'Nobody has joined yet.'));
    body.push(chips);
    if (v.players.some((x) => x.score > 0)) body.push(el('p', 'mg-muted', 'Last game'), board(v));
  }

  if (playing && (v.phase === 'lobby' || v.phase === 'final')) row.append(button(v.phase === 'final' ? 'Play again' : 'Start', () => send({ k: 'start' }), 'primary'));
  row.append(playing ? button('Leave', () => send({ k: 'leave' })) : button('Join', () => send({ k: 'join' }), 'primary'));

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, el('h2', '', 'Trivia night'), ...body, row);
  p.hidden = false;
  tickClock();
}

/** Run the countdown bar from the time left in the last view. */
function tickClock() {
  const c = ctx.panel.querySelector<HTMLElement>('.mg-trivia-clock');
  if (!c || !view || !view.span) return;
  const left = Math.max(0, view.left - (performance.now() - viewAt));
  c.querySelector<HTMLElement>('i')!.style.width = `${(left / view.span) * 100}%`;
  const num = c.querySelector('b');
  if (num) num.textContent = String(Math.ceil(left / 1000));
  c.classList.toggle('low', view.phase === 'question' && left <= 5000);
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as TriviaView;
    viewAt = performance.now();
    const me = ctx.myId();
    if (view.phase !== 'question' || myPick?.round !== view.round) myPick = null;
    if (view.phase === 'question' && view.mine !== undefined) myPick = { round: view.round, choice: view.mine };
    if (inGame()) {
      // A sound for my right answers, and a party for whoever comes top.
      if (view.phase === 'reveal' && before?.phase !== 'reveal' && view.gained?.[me]) ctx.play('pop');
      if (view.phase === 'final' && before?.phase !== 'final' && view.winners?.includes(me)) {
        ctx.confetti(['🏆', '🎉', '✨', '🧠']);
        ctx.play('tada');
      }
    }
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (!ctx.panel.hidden && (view?.phase === 'question' || view?.phase === 'reveal')) tickClock();
  },
  key(code) {
    if (ctx.panel.hidden) return false;
    if (code === 'Escape' && !inGame()) {
      open = false;
      render();
      return true;
    }
    // 1 to 4 answer, but only while a question is open for me; otherwise they stay as reactions.
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(code);
    if (m && canAnswer()) {
      pick(+m[1] - 1);
      return true;
    }
    return false;
  },
  reset() {
    view = null;
    open = false;
    myPick = null;
    render();
  },
};
