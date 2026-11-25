// Poker through the real server: what each player is told, and a hand played to the end.
const URL = process.env.WS_URL ?? 'ws://localhost:5173/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) process.exitCode = 1;
};
async function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, raw: [], view: null, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') c.id = m.id;
    if (m.t === 'table' && m.table === 'poker') {
      c.view = m.view;
      c.raw.push(e.data);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  c.send({ t: 'join', name, color: '#3a86ff' });
  await wait(250);
  return c;
}
const act = (p, a) => p.send({ t: 'game', table: 'poker', a });

const a = await client('Ann');
const b = await client('Bao');
const c = await client('Chi');
const all = [a, b, c];
const byId = Object.fromEntries(all.map((p) => [p.id, p]));

a.send({ t: 'sit', seat: 'poker:0' });
await wait(150);
act(a, { k: 'deal' });
await wait(150);
check('cannot deal alone', a.view.phase === 'lobby');
b.send({ t: 'sit', seat: 'poker:1' });
c.send({ t: 'sit', seat: 'poker:2' });
await wait(250);
act(b, { k: 'deal' });
await wait(250);

check('hand dealt to all three', all.every((p) => p.view.phase === 'preflop' && p.view.players.length === 3));
const mine = (p) => p.view.players.find((x) => x.id === p.id);
check('you see your own two cards', all.every((p) => mine(p).hole?.length === 2));
check("you do not see anyone else's cards", all.every((p) => p.view.players.filter((x) => x.id !== p.id).every((x) => x.hole === null)));
const others = [...mine(b).hole, ...mine(c).hole];
check("other players' cards are nowhere in your messages", others.every((card) => !a.raw.join('').includes(`"${card}"`)));
check('blinds posted and pot is 30', a.view.pot === 30);

const first = byId[a.view.turn];
const notFirst = all.find((p) => p !== first);
act(notFirst, { k: 'fold' });
await wait(150);
check('out-of-turn fold ignored', !notFirst.view.players.find((x) => x.id === notFirst.id).folded);
check('only the player to act is offered a raise', first.view.raise?.min === 40 && notFirst.view.raise === null);
act(first, { k: 'raise', to: 25 });
await wait(150);
check('too-small raise refused by the server', a.view.pot === 30);
act(first, { k: 'raise', to: 60 });
await wait(150);
check('raise accepted', a.view.pot === 90 && byId[a.view.turn] !== first);

let steps = 0;
while (a.view.phase !== 'showdown' && steps < 40) {
  act(byId[a.view.turn], { k: 'call' });
  await wait(80);
  steps++;
}
check('calls and checks reach a showdown', a.view.phase === 'showdown' && a.view.board.length === 5);
check('hands are turned over at showdown', a.view.players.every((x) => x.hole?.length === 2));
check(`a winner is announced (${a.view.results.join('; ')})`, a.view.results.length >= 1 && a.view.results[0].includes('wins'));
check('chips add up to 3,000', a.view.players.reduce((s, x) => s + x.chips, 0) === 3000);

act(c, { k: 'deal' });
await wait(200);
check('next hand deals, button moves', a.view.phase === 'preflop' && a.view.players.findIndex((x) => x.dealer) === 1);
const leaver = byId[a.view.turn];
const stay = all.filter((p) => p !== leaver);
leaver.send({ t: 'sit', seat: null });
await wait(250);
check('standing up on your turn folds you and play moves on', stay[0].view.players.find((x) => x.id === leaver.id).folded && stay[0].view.turn !== leaver.id);
stay[1].close();
await wait(400);
check('last player left wins the pot', stay[0].view.phase === 'showdown' && stay[0].view.results[0].includes('wins'));
for (const p of all) p.close();
