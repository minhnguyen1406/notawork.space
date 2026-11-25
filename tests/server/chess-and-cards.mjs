const URL = process.env.WS_URL ?? 'ws://localhost:5173/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) process.exitCode = 1; };
async function client(name) {
  const ws = new WebSocket(URL); const c = { name, msgs: [], views: {}, notices: [], send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); c.msgs.push(m); if (m.t === 'welcome') c.id = m.id; if (m.t === 'table') c.views[m.table] = m.view; if (m.t === 'notice') c.notices.push(m.text); };
  await new Promise((r) => (ws.onopen = r)); c.send({ t: 'join', name, color: '#3a86ff' }); await wait(250); return c;
}
const a = await client('Ann'), b = await client('Bao'), c = await client('Chi');
const game = (p, table, act) => p.send({ t: 'game', table, a: act });

// ---- chess
a.send({ t: 'sit', seat: 'chess:0' }); b.send({ t: 'sit', seat: 'chess:1' }); c.send({ t: 'sit', seat: 'chess:2' }); await wait(300);
check('chess: sides assigned by seat', a.views.chess?.you === 'w' && b.views.chess?.you === 'b' && c.views.chess?.you === null);
check('chess: names shown', b.views.chess.white === 'Ann' && b.views.chess.black === 'Bao');
game(b, 'chess', { k: 'move', from: 'e7', to: 'e5' }); await wait(150);
check('chess: cannot move out of turn', a.views.chess.fen.startsWith('rnbqkbnr/pppppppp'));
game(a, 'chess', { k: 'move', from: 'e2', to: 'e5' }); await wait(150);
check('chess: illegal move refused', a.views.chess.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP'));
game(c, 'chess', { k: 'move', from: 'e2', to: 'e4' }); await wait(150);
check('chess: a watcher cannot move', a.views.chess.fen.includes('PPPPPPPP/RNBQKBNR w'));
for (const [p, from, to] of [[a, 'f2', 'f3'], [b, 'e7', 'e5'], [a, 'g2', 'g4'], [b, 'd8', 'h4']]) { game(p, 'chess', { k: 'move', from, to }); await wait(150); }
check('chess: checkmate detected and everyone sees it', a.views.chess.status === 'checkmate' && c.views.chess.status === 'checkmate' && c.views.chess.last.to === 'h4');
check('chess: win announced', a.notices.includes('Bao won at chess by checkmate'));
game(a, 'chess', { k: 'new' }); await wait(150);
check('chess: new game resets the board', b.views.chess.status === 'playing' && b.views.chess.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'));
for (const p of [a, b, c]) p.send({ t: 'sit', seat: null }); await wait(200);

// ---- Last Card
a.send({ t: 'sit', seat: 'cards:0' }); await wait(150);
game(a, 'cards', { k: 'start' }); await wait(150);
check('cards: cannot start alone', a.views.cards.phase === 'lobby');
b.send({ t: 'sit', seat: 'cards:1' }); c.send({ t: 'sit', seat: 'cards:2' }); await wait(250);
check('cards: lobby lists everyone seated', a.views.cards.players.length === 3);
game(a, 'cards', { k: 'start' }); await wait(250);
const all = [a, b, c]; const byId = Object.fromEntries(all.map((p) => [p.id, p]));
check('cards: seven cards each', all.every((p) => p.views.cards.hand.length === 7));
check('cards: hands differ and only your own hand is sent', new Set(all.flatMap((p) => p.views.cards.hand)).size === 21 && all.every((p) => !JSON.stringify(p.views.cards.players).match(/"hand"/)));
const raw = JSON.stringify(a.msgs.filter((m) => m.t === 'table' && m.table === 'cards'));
check("cards: other players' cards never appear in your messages", b.views.cards.hand.filter((card) => card !== a.views.cards.top && !a.views.cards.hand.includes(card)).every((card) => !raw.includes(`"${card}"`)));
const notTurn = all.find((p) => p.id !== a.views.cards.turn);
const before = notTurn.views.cards.hand.length;
game(notTurn, 'cards', { k: 'draw' }); game(notTurn, 'cards', { k: 'play', card: notTurn.views.cards.hand[0] }); await wait(200);
check('cards: cannot act out of turn', notTurn.views.cards.hand.length === before);
const playable = (v, card) => v.pending > 0 ? card[0] === '2' : card[0] === '8' || card[1] === v.suit || card[0] === v.top[0];
let illegalTried = false, turns = 0;
while (a.views.cards.phase === 'play' && turns < 600) {
  const p = byId[a.views.cards.turn]; const v = p.views.cards;
  if (!illegalTried) { const bad = v.hand.find((card) => !playable(v, card)); if (bad) { illegalTried = true; game(p, 'cards', { k: 'play', card: bad }); await wait(120); check('cards: unplayable card refused', p.views.cards.hand.length === v.hand.length && p.views.cards.turn === p.id); } }
  const card = p.views.cards.hand.find((x) => playable(p.views.cards, x));
  if (card) game(p, 'cards', { k: 'play', card, suit: 'H' }); else game(p, 'cards', { k: 'draw' });
  turns++; await wait(35);
}
await wait(200);
const v = a.views.cards;
check(`cards: a full game plays to a winner (${turns} turns, winner ${v.winner})`, v.phase === 'over' && !!v.winner && v.players.find((p) => p.name === v.winner).count === 0);
check('cards: win announced', a.notices.includes(`${v.winner} won at Last Card`));
game(b, 'cards', { k: 'start' }); await wait(200);
check('cards: can deal again', a.views.cards.phase === 'play');
c.send({ t: 'sit', seat: null }); await wait(200);
check('cards: someone leaving keeps the game going for the rest', a.views.cards.phase === 'play' && a.views.cards.players.length === 2);
b.close(); await wait(400);
check('cards: down to one player returns to the lobby', a.views.cards.phase === 'lobby');
a.close(); c.close();
