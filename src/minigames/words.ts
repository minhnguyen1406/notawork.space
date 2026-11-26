import {
  CLUE_MAX_LEN, CLUE_MS, GUESS_MS, WORDS_MAX, WORDS_MIN, clueProblem, wordsReady, type Kind, type Team, type WordsAction, type WordsGame, type WordsView,
} from '../../shared/minigames/words';
import type { ClientGame, GameCtx } from './api';
import './words.css';

let ctx: GameCtx;
let view: WordsView | null = null;
/** When the current view arrived, to run its countdown locally. */
let viewAt = 0;
/** The panel only shows for people who opened it or are playing. */
let open = false;
/** A half-typed clue, kept here because the panel is rebuilt whenever a view arrives. */
let draft = '';
let draftN = 1;

const EMPTY: WordsView = {
  players: [], phase: 'lobby', cells: [], secret: null, turn: 'red', clue: null, guesses: 0, guessesLeft: 0, remaining: { red: 0, blue: 0 }, left: 0, result: null,
};
const TEAM: Record<Team, string> = { red: 'Red', blue: 'Blue' };

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
const send = (a: WordsAction) => ctx.send(a);
const mine = () => view?.players.find((p) => p.id === ctx.myId()) ?? null;
const inGame = () => !!mine();

function giveClue() {
  if (!view) return;
  const problem = clueProblem(view.cells.map((c) => c.word), draft);
  // The server checks again; this just tells the clue-giver why at once.
  if (problem) ctx.toast(problem);
  else send({ k: 'clue', word: draft.trim(), n: draftN });
}

function statusText(v: WordsView): string {
  const me = mine();
  const giverName = v.players.find((p) => p.team === v.turn && p.giver)?.name ?? 'Someone';
  if (v.phase === 'clue') {
    if (me?.giver && me.team === v.turn) return 'Your turn: give your team a one-word clue and a number.';
    return `${TEAM[v.turn]} team: ${giverName} is thinking of a clue…`;
  }
  if (v.phase === 'guess') {
    if (me && !me.giver && me.team === v.turn) return 'Your team is guessing: click a word.';
    if (me?.giver && me.team === v.turn) return 'Your team is guessing. Keep a straight face.';
    return `${TEAM[v.turn]} team is guessing.`;
  }
  if (v.players.length < WORDS_MIN) return `Needs ${WORDS_MIN} or more to play: two a side (up to ${WORDS_MAX}).`;
  // The rule only reads the players, so the view can stand in for the game here.
  if (!wordsReady(v as unknown as WordsGame)) return 'Each team needs a clue-giver and at least one guesser.';
  return 'Ready: anyone playing can press Start.';
}

function resultText(v: WordsView): string {
  if (!v.result) return '';
  const { winner, reason } = v.result;
  if (!winner) return 'The last game stopped early.';
  return reason === 'trap' ? `${TEAM[winner === 'red' ? 'blue' : 'red']} team hit the trap: ${TEAM[winner]} team wins!` : `${TEAM[winner]} team found all its words and wins!`;
}

function roster(v: WordsView, t: Team): HTMLElement {
  const me = ctx.myId();
  const box = el('div', `mg-words-team ${t}${v.phase !== 'lobby' && v.turn === t ? ' turn' : ''}`);
  box.append(el('h3', '', `${TEAM[t]} team${v.phase !== 'lobby' ? ` · ${v.remaining[t]} to find` : ''}`));
  const chips = el('div', 'mg-players');
  for (const p of v.players.filter((x) => x.team === t)) {
    // Highlight whoever the game is waiting on: the clue-giver, then the guessers.
    const acting = v.turn === t && ((v.phase === 'clue' && p.giver) || (v.phase === 'guess' && !p.giver));
    chips.append(el('span', `mg-chip${p.id === me ? ' me' : ''}${acting ? ' turn' : ''}${p.giver ? ' giver' : ''}`, p.giver ? `${p.name} · clue-giver` : p.name));
  }
  if (!chips.childElementCount) chips.append(el('span', 'mg-muted', 'Nobody yet.'));
  box.append(chips);
  return box;
}

function render() {
  const p = ctx.panel;
  if (!open && !inGame()) {
    p.hidden = true;
    return;
  }
  // Rebuilding the panel would otherwise drop the cursor out of the clue box.
  const typing = document.activeElement instanceof HTMLInputElement && p.contains(document.activeElement);
  p.className = 'mg mg-sheet mg-words';
  const v = view ?? EMPTY;
  const me = mine();
  const playing = v.phase !== 'lobby';
  const myTurn = !!me && playing && me.team === v.turn;
  const canGuess = myTurn && v.phase === 'guess' && !me.giver;

  const head: HTMLElement[] = [el('h2', '', 'Word clues')];
  if (v.result && !playing) head.push(el('p', `mg-words-result ${v.result.winner ?? 'none'}`, resultText(v)));
  head.push(el('p', 'mg-status', statusText(v)));

  const body: HTMLElement[] = [];
  if (playing) {
    const bar = el('div', `mg-words-turn ${v.turn}`);
    bar.append(el('b', '', `${TEAM[v.turn]} team's turn`));
    if (v.phase === 'guess' && v.clue) {
      bar.append(el('span', 'mg-words-clue', `${v.clue.word} · ${v.clue.n}`), el('span', 'mg-words-left', `${v.guessesLeft} ${v.guessesLeft === 1 ? 'guess' : 'guesses'} left`));
    } else bar.append(el('span', 'mg-muted', 'Waiting for the clue'));
    bar.append(el('span', 'mg-words-time'));
    const clock = el('div', 'mg-words-clock');
    clock.append(el('i'));
    body.push(bar, clock);
  }

  if (v.cells.length) {
    const grid = el('div', `mg-words-grid${v.secret ? ' secret' : ''}`);
    v.cells.forEach((c, i) => {
      // A clue-giver's map tints the face-down cards; so does the full reveal once a game is over.
      const kind: Kind | null = c.kind ?? v.secret?.[i] ?? null;
      const b = button(c.word, () => send({ k: 'guess', i }), `mg-words-cell${c.open ? ` open k-${kind}` : kind ? ` s-${kind}` : ''}`);
      b.dataset.i = String(i);
      b.disabled = !canGuess || c.open;
      grid.append(b);
    });
    body.push(grid);
  }
  if (v.secret) body.push(el('p', 'mg-muted', 'You are a clue-giver: the tinted cards are the secret map. Dark is the trap. Say nothing but your clue.'));

  const row = el('div', 'mg-row');
  if (myTurn && v.phase === 'clue' && me.giver) {
    const input = el('input', 'mg-words-input');
    input.type = 'text';
    input.maxLength = CLUE_MAX_LEN;
    input.placeholder = 'One-word clue';
    input.autocomplete = 'off';
    input.value = draft;
    input.oninput = () => (draft = input.value);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') giveClue();
    };
    const num = el('select', 'mg-words-num');
    for (let n = 1; n <= 9; n++) num.append(new Option(String(n), String(n), false, n === draftN));
    num.onchange = () => (draftN = Number(num.value));
    row.append(input, num, button('Give clue', giveClue, 'primary'));
  }
  if (canGuess) {
    const end = button('End turn', () => send({ k: 'end' }));
    end.disabled = v.guesses < 1;
    row.append(end);
  }
  if (!playing && me) {
    const start = button(v.result ? 'Play again' : 'Start', () => send({ k: 'start' }), 'primary');
    start.disabled = !wordsReady(v as unknown as WordsGame);
    const vol = button('Be clue-giver', () => send({ k: 'giver' }));
    vol.disabled = me.giver;
    row.append(start, button(`Switch to ${TEAM[me.team === 'red' ? 'blue' : 'red']}`, () => send({ k: 'switch' })), vol);
  }
  if (me) row.append(button('Leave', () => send({ k: 'leave' })));
  else {
    const join = button('Join', () => send({ k: 'join' }), 'primary');
    join.disabled = playing || v.players.length >= WORDS_MAX;
    row.append(join);
    if (playing) row.append(el('span', 'mg-muted', 'A game is under way. You can watch, and join the next one.'));
  }

  const teams = el('div', 'mg-words-teams');
  teams.append(roster(v, 'red'), roster(v, 'blue'));

  const close = button('Close', () => {
    open = false;
    if (inGame()) send({ k: 'leave' });
    render();
  }, 'mg-close');
  p.replaceChildren(close, ...head, ...body, row, teams);
  p.hidden = false;
  if (typing) p.querySelector<HTMLInputElement>('.mg-words-input')?.focus();
}

export const game: ClientGame = {
  init(c) {
    ctx = c;
  },
  onView(v) {
    const before = view;
    view = v as WordsView;
    viewAt = performance.now();
    const me = mine();
    // A fresh turn starts with an empty clue box.
    if (view.phase !== 'clue' || before?.turn !== view.turn || before?.phase !== 'clue') {
      draft = '';
      draftN = 1;
    }
    if (me && before && before.phase !== view.phase) {
      if (view.phase === 'lobby' && before.phase !== 'lobby' && view.result?.winner === me.team) {
        ctx.confetti();
        ctx.play('tada');
      } else if (view.turn === me.team && ((view.phase === 'clue' && me.giver) || (view.phase === 'guess' && !me.giver))) ctx.play('pop'); // my move
    }
    render();
  },
  open() {
    open = true;
    render();
  },
  frame() {
    if (!view || view.phase === 'lobby' || ctx.panel.hidden) return;
    const left = Math.max(0, view.left - (performance.now() - viewAt));
    const bar = ctx.panel.querySelector<HTMLElement>('.mg-words-clock i');
    if (bar) bar.style.width = `${(left / (view.phase === 'clue' ? CLUE_MS : GUESS_MS)) * 100}%`;
    const time = ctx.panel.querySelector<HTMLElement>('.mg-words-time');
    const text = `${Math.ceil(left / 1000)}s`;
    if (time && time.textContent !== text) time.textContent = text;
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
    draft = '';
    draftN = 1;
    render();
  },
};
