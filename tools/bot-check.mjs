// Checks the Claude character against a local dev server: start `npm run dev`, then
// `node tools/claude-bot.mjs --local` in another terminal, then run this. It sits down as White,
// plays random legal moves, and reports what Claude said and how the game ended.
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

const password = readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket('ws://localhost:5173/ws');
const send = (m) => ws.send(JSON.stringify(m));
const said = [];
let view = null;
let claude = null;
const people = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') for (const p of m.players) people.set(p.id, p);
  if (m.t === 'join') people.set(m.player.id, m.player);
  if (m.t === 'state') for (const [id, x, z] of m.players) if (people.has(id)) Object.assign(people.get(id), { x, z });
  if (m.t === 'sit' && people.has(m.id)) people.get(m.id).seat = m.seat;
  if (m.t === 'chat' && m.name === 'Claude') said.push(m.text);
  if (m.t === 'table' && m.table === 'chess') view = m.view;
};
await new Promise((r) => (ws.onopen = r));
send({ t: 'join', name: 'Tester', color: '#3a86ff', password });
await sleep(500);
send({ t: 'sit', seat: 'chess:0' });

let ok = true;
const check = (label, pass) => {
  console.log((pass ? 'PASS ' : 'FAIL ') + label);
  if (!pass) ok = false;
};
// Wait for Claude to walk over and sit.
for (let i = 0; i < 60 && !claude?.seat; i++) {
  await sleep(500);
  claude = [...people.values()].find((p) => p.name === 'Claude');
}
check(`Claude walked over and sat down (${claude?.seat})`, claude?.seat === 'chess:1');
check('Claude greeted the room', said.some((s) => s.includes('Claude here')));

let moves = 0;
const started = Date.now();
while (view && view.status === 'playing' && moves < 120 && Date.now() - started < 240_000) {
  const chess = new Chess(view.fen);
  if (chess.turn() === 'w') {
    const options = chess.moves({ verbose: true });
    const m = options[Math.floor(Math.random() * options.length)];
    const before = view.fen;
    send({ t: 'game', table: 'chess', a: { k: 'move', from: m.from, to: m.to } });
    moves++;
    // Wait for Claude's reply (the position changes twice: our move, then theirs).
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      if (view.fen !== before && (view.status !== 'playing' || new Chess(view.fen).turn() === 'w')) break;
    }
  } else await sleep(100);
}
console.log(`game: ${moves} moves by the tester, ended as "${view?.status}" after ${Math.round((Date.now() - started) / 1000)} s`);
check('Claude answered every move (the game never stalled)', view?.status !== 'playing' || moves >= 120);
check('Claude beat a player who moves at random', view?.status === 'checkmate' && new Chess(view.fen).turn() === 'w');
await sleep(1500);
console.log('Claude said:');
for (const s of said) console.log('  ·', s);
ws.close();
process.exit(ok ? 0 : 1);
