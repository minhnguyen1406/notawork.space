// Werewolf and Phố Lớn through the real server: what each player is told, and games played to the end.
const URL = process.env.WS_URL ?? 'ws://localhost:5173/ws';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) process.exitCode = 1;
};
async function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, raw: [], views: {}, notices: [], send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome') c.id = m.id;
    if (m.t === 'notice') c.notices.push(m.text);
    if (m.t === 'table') {
      c.views[m.table] = m.view;
      c.raw.push(e.data);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  c.send({ t: 'join', name, color: '#3a86ff' });
  await wait(200);
  return c;
}
const act = (p, table, a) => p.send({ t: 'game', table, a });

const names = ['Ann', 'Bao', 'Chi', 'Dung', 'Em', 'Giang'];
const all = [];
for (const n of names) all.push(await client(n));
const byId = Object.fromEntries(all.map((p) => [p.id, p]));

// ---------------------------------------------------------------- Werewolf
for (let i = 0; i < 4; i++) all[i].send({ t: 'sit', seat: `wolf:${i}` });
await wait(300);
act(all[0], 'wolf', { k: 'start' });
await wait(200);
check('werewolf: cannot start with four', all[0].views.wolf.phase !== 'night');
for (let i = 4; i < 6; i++) all[i].send({ t: 'sit', seat: `wolf:${i}` });
await wait(300);
for (const p of all) p.raw.length = 0; // only judge what is sent during this game
act(all[0], 'wolf', { k: 'start' });
await wait(300);
const W = (p) => p.views.wolf;
check('werewolf: game starts at night for six', all.every((p) => W(p).phase === 'night' && W(p).players.length === 6));
const roles = all.map((p) => W(p).yourRole);
check(`werewolf: roles dealt (${roles.join(', ')})`, roles.filter((r) => r === 'werewolf').length === 1 && roles.includes('seer') && roles.includes('doctor') && roles.filter((r) => r === 'villager').length === 3);
check('werewolf: you only see your own role', all.every((p) => W(p).players.every((x) => (x.id === p.id ? x.role === W(p).yourRole : x.role === null))));
const wolf = all.find((p) => W(p).yourRole === 'werewolf');
const seer = all.find((p) => W(p).yourRole === 'seer');
const doctor = all.find((p) => W(p).yourRole === 'doctor');
const villagers = all.filter((p) => W(p).yourRole === 'villager');
check('werewolf: the word "werewolf" never reaches a villager about anyone else', villagers.every((v) => !v.raw.join('').includes('"role":"werewolf"')));
check('werewolf: only role-holders are offered a night action', W(wolf).night.can === 'kill' && W(seer).night.can === 'look' && W(doctor).night.can === 'protect' && villagers.every((v) => W(v).night.can === null));

act(villagers[0], 'wolf', { k: 'night', target: wolf.id });
act(villagers[0], 'wolf', { k: 'vote', target: wolf.id });
act(villagers[0], 'wolf', { k: 'force' });
await wait(200);
check('werewolf: a villager cannot act at night, vote at night, or skip the wait', W(wolf).phase === 'night' && W(wolf).night.picks.length === 0);

const victim = villagers[0];
act(wolf, 'wolf', { k: 'night', target: victim.id });
await wait(150);
check("werewolf: the pack's pick is shown to the werewolf only", W(wolf).night.picks.length === 1 && W(seer).night.picks.length === 0 && !seer.raw.at(-1).includes(victim.name + '"}]'));
act(seer, 'wolf', { k: 'night', target: wolf.id });
await wait(150);
check('werewolf: the seer is told the truth and nobody else is', W(seer).notes[0] === `Night 1: ${wolf.name} is a WEREWOLF.` && all.filter((p) => p !== seer).every((p) => W(p).notes.length === 0 && !p.raw.join('').includes('WEREWOLF')));
act(doctor, 'wolf', { k: 'night', target: doctor.id });
await wait(250);
check('werewolf: morning comes when everyone has acted, and the victim is out', all.every((p) => W(p).phase === 'day') && W(wolf).players.find((x) => x.id === victim.id).alive === false);
check("werewolf: the dead player's role is revealed to all", all.every((p) => W(p).players.find((x) => x.id === victim.id).role === 'villager'));
check('werewolf: the dead see every role', W(victim).players.every((x) => x.role !== null));
check('werewolf: the living still do not', W(villagers[1]).players.find((x) => x.id === wolf.id).role === null);

act(victim, 'wolf', { k: 'vote', target: wolf.id });
await wait(150);
check('werewolf: the dead cannot vote', W(wolf).votes.length === 0);
const living = all.filter((p) => p !== victim);
for (const p of living) act(p, 'wolf', { k: 'vote', target: p === wolf ? seer.id : wolf.id });
await wait(300);
check('werewolf: voting out the werewolf wins it for the village', all.every((p) => W(p).phase === 'over' && W(p).winner === 'village'));
check('werewolf: every role is shown at the end', W(villagers[1]).players.every((x) => x.role !== null));
check('werewolf: the result is announced to the room', all[0].notices.includes('Werewolf: the village won'));
act(all[1], 'wolf', { k: 'start' });
await wait(250);
check('werewolf: a new game can start afterwards', W(all[0]).phase === 'night' && W(all[0]).round === 1);
for (const p of all) p.send({ t: 'sit', seat: null });
await wait(300);

// ---------------------------------------------------------------- Phố Lớn
const [a, b, c] = all;
a.send({ t: 'sit', seat: 'pho:n0' });
await wait(150);
act(a, 'pho', { k: 'start' });
await wait(150);
check('pho: cannot start alone', a.views.pho.phase === 'lobby' || a.views.pho.phase === 'over');
b.send({ t: 'sit', seat: 'pho:n1' });
c.send({ t: 'sit', seat: 'pho:s0' });
await wait(250);
act(a, 'pho', { k: 'start' });
await wait(250);
const P = () => a.views.pho;
check('pho: three players start with 1500 each', P().phase === 'roll' && P().order.length === 3 && Object.values(P().cash).every((x) => x === 1500));
const cur = () => byId[P().order[P().turn]];
const other = [a, b, c].find((p) => p !== cur());
act(other, 'pho', { k: 'roll' });
await wait(150);
check('pho: only the current player can roll', P().die === null);
act(cur(), 'pho', { k: 'end' });
await wait(150);
check('pho: cannot end a turn before rolling', P().phase === 'roll');

let bought = false;
let rentPaid = false;
let built = false;
let turns = 0;
while (P().phase !== 'over' && turns < 220) {
  const p = cur();
  const v = P();
  if (v.phase === 'roll') act(p, 'pho', { k: 'roll' });
  else if (v.phase === 'buy') {
    act(p, 'pho', { k: 'buy', yes: true });
    bought = true;
  } else {
    // build on the first space the rules allow, if any
    for (let s = 0; s < 24; s++) act(p, 'pho', { k: 'build', space: s });
    act(p, 'pho', { k: 'end' });
    turns++;
  }
  await wait(25);
  if (P().log.some((l) => l.includes('rent'))) rentPaid = true;
  if (P().log.some((l) => l.includes('builds a'))) built = true;
}
await wait(200);
check(`pho: cities were bought and rent was paid (${turns} turns)`, bought && rentPaid);
console.log(`INFO pho: a building went up this game: ${built} (needs a full colour pair, so it is down to luck; covered by the rule tests)`);
check('pho: everyone at the table sees the same board', JSON.stringify(a.views.pho.owner) === JSON.stringify(b.views.pho.owner) && JSON.stringify(a.views.pho.cash) === JSON.stringify(c.views.pho.cash));
check('pho: nobody is ever in debt', Object.values(P().cash).every((x) => x >= 0));
if (P().phase !== 'over') {
  act(cur(), 'pho', { k: 'finish' });
  await wait(250);
}
check(`pho: the game ends with a winner (${P().winner})`, P().phase === 'over' && !!P().winner);
check('pho: the winner is announced to the room', all[3].notices.includes(`${P().winner} won at Phố Lớn`));
act(a, 'pho', { k: 'start' });
await wait(250);
check('pho: a new game can start afterwards', P().phase === 'roll');
b.send({ t: 'sit', seat: null });
await wait(250);
check('pho: someone standing up leaves the game and the rest carry on', P().order.length === 2 && P().phase !== 'over');
c.close();
await wait(400);
check('pho: down to one player, they win', P().phase === 'over');
for (const p of all) p.close();
