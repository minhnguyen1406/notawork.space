// A broken connection keeps your place for a minute; a tidy goodbye does not. Needs `npm run dev`.
import { readFileSync } from 'node:fs';
const WS = process.env.WS_URL ?? 'ws://localhost:5173/ws';
// The local server may have a room password set; it lives in the git-ignored settings file.
const password = readFileSync(new URL('../../worker/.dev.vars', import.meta.url), 'utf8').match(/^ROOM_PASSWORD=(.*)$/m)?.[1] || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) process.exitCode = 1; };
/** Join the room. `resume` is the key from an earlier welcome. */
async function client(name, resume) {
  const ws = new WebSocket(WS);
  const c = { name, msgs: [], views: {}, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close(), snap: () => ws.close(4001, 'test drop'), ws };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    c.msgs.push(m);
    if (m.t === 'welcome') Object.assign(c, { id: m.id, key: m.resume, welcome: m });
    if (m.t === 'table') c.views[m.table] = m.view;
  };
  await new Promise((r) => (ws.onopen = r));
  c.send({ t: 'join', name, color: '#3a86ff', resume, password });
  await wait(300);
  return c;
}
const game = (p, table, act) => p.send({ t: 'game', table, a: act });
const saw = (p, t, id) => p.msgs.some((m) => m.t === t && m.id === id);

const a = await client('Ann'), b = await client('Bao');
check('the welcome carries a long private key', typeof a.key === 'string' && a.key.length > 40 && a.key !== b.key);
check('nobody else is ever sent your key', !JSON.stringify(b.msgs).includes(a.key));

// ---- a broken connection in the middle of a card game
a.send({ t: 'sit', seat: 'cards:0' }); b.send({ t: 'sit', seat: 'cards:1' }); await wait(250);
game(a, 'cards', { k: 'start' }); await wait(300);
const hand = a.views.cards.hand;
check('a game of Last Card is under way', a.views.cards.phase === 'play' && hand.length === 7);
a.snap(); await wait(500);
check('the others are told the place is being held', b.msgs.some((m) => m.t === 'away' && m.id === a.id && m.away === true));
check('and are not told the player left', !saw(b, 'leave', a.id));
check('the game carries on with them still in it', b.views.cards.phase === 'play' && b.views.cards.players.length === 2);

const a2 = await client('Ann', a.key);
check('coming back with the key gives the same identity', a2.id === a.id);
check('still in the same seat', a2.welcome.players.find((p) => p.id === a.id)?.seat === 'cards:0');
check('with the same hand of cards', JSON.stringify(a2.views.cards?.hand) === JSON.stringify(hand));
check('the others are told they are back, not that someone new came in', b.msgs.some((m) => m.t === 'away' && m.id === a.id && m.away === false) && !b.msgs.some((m) => m.t === 'join' && m.player.id === a.id));
check('there is still only one of them in the room', a2.welcome.players.filter((p) => p.name === 'Ann').length === 1);

// ---- reconnecting before the server has noticed the old connection die
const a3 = await client('Ann', a.key);
check('a second connection with the key takes over from the first', a3.id === a.id && a3.views.cards?.hand?.length === 7);
await wait(300);
check('the old connection is closed', a2.ws.readyState === WebSocket.CLOSED);
check('and nobody sees a departure', !saw(b, 'leave', a.id));
a3.send({ t: 'move', x: 0, z: 0, ry: 0 });
await wait(200);
check('the new connection is the live one', !saw(b, 'leave', a.id) && a3.ws.readyState === WebSocket.OPEN);

// ---- keys cannot be guessed or borrowed
const c = await client('Chi', 'x'.repeat(72));
check('a made-up key just makes you a newcomer', c.id !== a.id && c.welcome.players.some((p) => p.id === c.id));
const d = await client('Dee', b.key.slice(0, -1) + (b.key.endsWith('0') ? '1' : '0'));
check('a nearly-right key does not take over someone else', d.id !== b.id && b.ws.readyState === WebSocket.OPEN);
c.close(); d.close(); await wait(300);

// ---- a tidy goodbye is immediate
check('closing normally means leaving at once', saw(b, 'leave', c.id) && saw(b, 'leave', d.id));
a3.send({ t: 'bye' }); await wait(400);
check('saying goodbye leaves at once, and ends your part in the game', saw(b, 'leave', a.id) && b.views.cards.phase !== 'play');
const a4 = await client('Ann', a.key);
check('a key is no use once you have really left', a4.id !== a.id && a4.welcome.players.find((p) => p.id === a4.id)?.seat === null);
a4.close(); await wait(300);

// ---- the hold runs out
const e = await client('Eve');
e.send({ t: 'sit', seat: 'cards:0' }); await wait(250);
e.snap(); await wait(1500);
check('a held seat stays taken', (await (async () => { b.send({ t: 'sit', seat: null }); await wait(150); b.send({ t: 'sit', seat: 'cards:0' }); await wait(300); return !b.msgs.some((m) => m.t === 'sit' && m.id === b.id && m.seat === 'cards:0'); })()));
if (process.env.QUICK) console.log('SKIP the one-minute wait (QUICK is set)');
else {
  await wait(61_000);
  check('after a minute with no return, they are gone', saw(b, 'leave', e.id));
  const e2 = await client('Eve', e.key);
  check('and the key no longer works', e2.id !== e.id);
  e2.close();
}
b.close();
await wait(300);
