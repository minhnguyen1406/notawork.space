// "Claude" as a character in the room: walks to the chess table, sits down and plays whoever sits
// opposite. Chat it hears is written to .claude-bot/chat.log; lines appended to .claude-bot/outbox.txt
// are said in the room.
//
//   npm run claude:join     join the live room (runs in the background)
//   npm run claude:leave    leave
//   node tools/claude-bot.mjs --local    join a local dev server instead
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bestMove } from './chess-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, '.claude-bot');
const args = process.argv.slice(2);
mkdirSync(DIR, { recursive: true });
const pidFile = join(DIR, 'pid');

if (args.includes('--leave')) {
  try {
    process.kill(+readFileSync(pidFile, 'utf8'));
    console.log('Claude left the room.');
  } catch {
    console.log('Claude was not in the room.');
  }
  process.exit(0);
}
if (args.includes('--detach')) {
  const out = openSync(join(DIR, 'bot.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter((a) => a !== '--detach')], { detached: true, stdio: ['ignore', out, out] });
  child.unref();
  console.log('Claude is joining the room. Look for the character called Claude, heading for the chess table.');
  process.exit(0);
}

const LOCAL = args.includes('--local');
const URL = LOCAL ? 'ws://localhost:5173/ws' : 'wss://notawork-space.notawork-space.workers.dev/ws';
const NAME = 'Claude';
// The room password comes from the same private file the server uses; it is never printed.
const password = (() => {
  try {
    return readFileSync(join(ROOT, 'worker/.dev.vars'), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] || undefined;
  } catch {
    return undefined;
  }
})();

const chatLog = join(DIR, 'chat.log');
const outbox = join(DIR, 'outbox.txt');
if (!existsSync(outbox)) writeFileSync(outbox, '');
let outboxAt = statSync(outbox).size;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const heard = (name, text) => appendFileSync(chatLog, JSON.stringify({ at: new Date().toISOString().slice(11, 19), name, text }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const ws = new WebSocket(URL);
const send = (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
let lastSaid = 0;
const queue = [];
/** Say something in chat, spaced out so the server's spam guard never drops a line. */
function say(text) {
  for (let i = 0; i < text.length; i += 190) queue.push(text.slice(i, i + 190));
}
setInterval(() => {
  if (queue.length && Date.now() - lastSaid > 900) {
    lastSaid = Date.now();
    send({ t: 'chat', text: queue.shift() });
  }
}, 200);

let myId = '';
const players = new Map(); // id -> { name, seat }
let pos = { x: 0, z: 10 };
let seat = null;
let view = null;
let thinking = false;
let lastFen = '';
let gameTalked = false;

async function walkTo(x, z) {
  const speed = 5; // metres a second, a normal walk
  for (;;) {
    const dx = x - pos.x;
    const dz = z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.15) return;
    const step = Math.min(d, speed / 10);
    pos = { x: pos.x + (dx / d) * step, z: pos.z + (dz / d) * step };
    send({ t: 'move', x: pos.x, z: pos.z, ry: Math.atan2(dx, dz) });
    await sleep(100);
  }
}

const seatTaken = (id) => [...players.values()].some((p) => p.seat === id);
async function goToChess() {
  await sleep(1500);
  send({ t: 'emote', k: '👋' });
  say("Hi, Claude here. I'm heading to the chess table in the games lounge. Sit opposite me and we'll play.");
  // Round the pitch-side corner, then in through the lounge's open side.
  for (const [x, z] of [[7.5, 14], [7.5, 20], [10.5, 23.8]]) await walkTo(x, z);
  const want = seatTaken('chess:1') ? 'chess:0' : 'chess:1'; // Black by choice, so the guest moves first
  if (seatTaken(want)) {
    say('Both chess seats are taken, so I will watch. Shout when one frees up.');
    send({ t: 'sit', seat: seatTaken('chess:2') ? 'chess:3' : 'chess:2' });
  } else {
    await walkTo(want === 'chess:1' ? 13.5 : 10.5, 24.6);
    send({ t: 'sit', seat: want });
  }
}

function onChess(v) {
  view = v;
  if (!v.you || thinking) return;
  const opponent = v.you === 'w' ? v.black : v.white;
  if (v.status !== 'playing') {
    if (lastFen !== v.fen) {
      lastFen = v.fen;
      const iLost = v.status === 'checkmate' && v.fen.split(' ')[1] === v.you;
      if (v.status === 'checkmate') {
        say(iLost ? 'Checkmate. Well played, you got me. Press "New game" for a rematch.' : 'Checkmate! Good game. Press "New game" if you want revenge.');
        send({ t: 'emote', k: iLost ? '👏' : 'dance' });
      } else say(`That's a draw (${v.status}). Good game. "New game" starts another.`);
      heard('*', `chess over: ${v.status}, Claude ${iLost ? 'lost' : v.status === 'checkmate' ? 'won' : 'drew'}`);
    }
    return;
  }
  const fresh = v.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w');
  if (fresh) gameTalked = false;
  if (!opponent) return;
  if (!gameTalked) {
    gameTalked = true;
    say(v.you === 'b' ? `Good luck, ${opponent}. You're White, so it's your move.` : `Good luck, ${opponent}. I'm White, here we go.`);
  }
  if (v.fen.split(' ')[1] !== v.you || v.fen === lastFen) return;
  lastFen = v.fen;
  thinking = true;
  // Think on the next tick so the socket keeps being served, then pause like a person would.
  setTimeout(async () => {
    const started = Date.now();
    const m = bestMove(v.fen, { ms: 2000, maxDepth: 4 });
    await sleep(Math.max(0, 900 + Math.random() * 1200 - (Date.now() - started)));
    thinking = false;
    if (!m) return;
    log(`chess: ${m.san} (score ${m.score}, depth ${m.depth})`);
    send({ t: 'game', table: 'chess', a: { k: 'move', from: m.from, to: m.to } });
    if (m.san.includes('#')) return;
    if (m.san.includes('+') && Math.random() < 0.6) say(pick(['Check.', 'Check!', 'Mind your king.']));
    else if (m.san.includes('x') && /^Q?[a-h]?x/.test(m.san) === false && Math.random() < 0.25) say(pick(['I will take that, thank you.', 'Yoink.', 'That one was loose.']));
    else if (m.score < -250 && Math.random() < 0.3) say(pick(['Hm. I do not love my position.', 'You are playing well.', 'I may regret that.']));
    else if (m.score > 300 && Math.random() < 0.2) say(pick(['I like where this is going.', 'Things are looking up for me.']));
    // The view that arrives after our own move may be the opponent's reply already.
    if (view && view.fen !== lastFen) onChess(view);
  }, 0);
}

ws.onopen = () => {
  log('connected to', LOCAL ? 'the local server' : 'the live room');
  writeFileSync(pidFile, String(process.pid));
  send({ t: 'join', name: NAME, color: '#f2efe6', password });
};
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  switch (m.t) {
    case 'welcome':
      myId = m.id;
      for (const p of m.players) players.set(p.id, { name: p.name, seat: p.seat });
      const me = m.players.find((p) => p.id === myId);
      pos = { x: me.x, z: me.z };
      heard('*', `Claude joined. In the room: ${m.players.filter((p) => p.id !== myId).map((p) => p.name).join(', ') || 'nobody else'}`);
      void goToChess();
      break;
    case 'denied':
      log('could not join:', m.reason);
      heard('*', `Claude could not join: ${m.reason}`);
      process.exit(1);
      break;
    case 'join':
      players.set(m.player.id, { name: m.player.name, seat: m.player.seat });
      heard('*', `${m.player.name} came in`);
      break;
    case 'leave':
      heard('*', `${players.get(m.id)?.name ?? 'someone'} left`);
      players.delete(m.id);
      break;
    case 'sit':
      if (players.has(m.id)) players.get(m.id).seat = m.seat;
      if (m.id === myId) seat = m.seat;
      else if (m.seat?.startsWith('chess:')) heard('*', `${players.get(m.id)?.name} sat at the chess table (${m.seat})`);
      break;
    case 'chat':
      if (m.id !== myId) heard(m.name, m.text);
      break;
    case 'table':
      if (m.table === 'chess') onChess(m.view);
      break;
  }
};
ws.onclose = () => {
  log('disconnected');
  heard('*', 'Claude was disconnected');
  process.exit(0);
};
ws.onerror = (e) => log('socket error', e.message ?? '');

setInterval(() => send({ t: 'ping' }), 20_000);
// Lines appended to the outbox are said in the room. "/quit" leaves, "/dance" dances, "/emote 🔥" reacts.
setInterval(() => {
  const size = statSync(outbox).size;
  if (size <= outboxAt) return;
  const text = readFileSync(outbox).subarray(outboxAt).toString('utf8'); // sizes are in bytes
  outboxAt = size;
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    if (line === '/quit') {
      say('I have to go. Thanks for the game!');
      setTimeout(() => process.exit(0), 2500);
    } else if (line === '/dance') send({ t: 'emote', k: 'dance' });
    else if (line.startsWith('/emote ')) send({ t: 'emote', k: line.slice(7) });
    else if (line === '/stand') send({ t: 'sit', seat: null });
    else say(line);
  }
}, 400);
process.on('SIGTERM', () => {
  ws.close();
  process.exit(0);
});
