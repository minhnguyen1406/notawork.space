// End-to-end check of the game server through the Vite proxy: join, move, chat, sit, cook a salad.
const URL = process.env.WS_URL ?? 'ws://localhost:5173/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name) {
  const ws = new WebSocket(URL);
  const c = { ws, msgs: [], id: null, kitchen: null, send: (m) => ws.send(JSON.stringify(m)) };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 'welcome') { c.id = m.id; c.kitchen = m.kitchen; } if (m.t === 'kitchen') c.kitchen = m.state; };
  c.ready = new Promise((res, rej) => { ws.onopen = () => { c.send({ t: 'join', name, color: '#3a86ff' }); res(); }; ws.onerror = () => rej(new Error('connect failed')); });
  return c;
}
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) process.exitCode = 1; };

const a = client('Ann'); await a.ready; await wait(300);
const b = client('Bao'); await b.ready; await wait(300);
check('both welcomed', !!a.id && !!b.id);
check('B sees A in welcome', b.msgs.find((m) => m.t === 'welcome').players.length === 2);
check('A told B joined', a.msgs.some((m) => m.t === 'join' && m.player.name === 'Bao'));
check('no media without LiveKit keys', a.msgs.find((m) => m.t === 'welcome').media === null);

a.send({ t: 'move', x: 16.5, z: 0, ry: 1 }); await wait(300);
check('B receives A position', b.msgs.some((m) => m.t === 'state' && m.players.some((p) => p[0] === a.id && p[1] === 16.5)));

a.send({ t: 'chat', text: 'hello <b>there</b>' }); await wait(200);
check('chat relayed', b.msgs.some((m) => m.t === 'chat' && m.text === 'hello <b>there</b>' && m.name === 'Ann'));

b.send({ t: 'sit', seat: 'lounge:0' }); await wait(200);
check('sit broadcast', a.msgs.some((m) => m.t === 'sit' && m.id === b.id && m.seat === 'lounge:0'));
a.send({ t: 'sit', seat: 'lounge:0' }); await wait(200);
check('taken seat refused', !a.msgs.some((m) => m.t === 'sit' && m.id === a.id));
b.send({ t: 'sit', seat: null }); await wait(150);

// Cook a salad
a.send({ t: 'use', station: 'hatch' }); await wait(150);
check('out-of-reach station ignored', !a.kitchen.held[a.id]);
a.send({ t: 'use', station: 'crate-lettuce' }); await wait(150);
check('took lettuce', a.kitchen.held[a.id]?.type === 'lettuce');
a.send({ t: 'use', station: 'board2' }); await wait(150);
for (let i = 0; i < 4; i++) { a.send({ t: 'act', station: 'board2' }); await wait(80); }
check('lettuce chopped', a.kitchen.slots.board2?.st === 'chopped');
a.send({ t: 'move', x: 16.5, z: -1, ry: 1 }); await wait(250);
a.send({ t: 'use', station: 'crate-tomato' }); await wait(150);
a.send({ t: 'use', station: 'board1' }); await wait(150);
for (let i = 0; i < 4; i++) { a.send({ t: 'act', station: 'board1' }); await wait(80); }
check('tomato chopped', a.kitchen.slots.board1?.st === 'chopped');
a.send({ t: 'move', x: 16, z: 8.5, ry: 1 }); await wait(250);
a.send({ t: 'use', station: 'plates' }); await wait(150);
check('holding plate', a.kitchen.held[a.id]?.k === 'plate');
// stove: raw patty cooks after 6s
a.send({ t: 'move', x: 16.5, z: -1, ry: 1 }); await wait(250);
a.send({ t: 'use', station: 'board2' }); await wait(150);
a.send({ t: 'use', station: 'board1' }); await wait(150);
check('plate has both', a.kitchen.held[a.id]?.c?.length === 2);
a.send({ t: 'move', x: 16, z: -3, ry: 1 }); await wait(250);
a.send({ t: 'use', station: 'hatch' }); await wait(250);
check('served notice', b.msgs.some((m) => m.t === 'notice' && m.text === 'Ann served a Garden Salad'));
check('total is 1', a.kitchen.total === 1 && a.kitchen.served.length === 1);

a.ws.close(); await wait(400);
check('B told A left', b.msgs.some((m) => m.t === 'leave' && m.id === a.id));
b.ws.close();
