// Is voice working on the live room? Checks that the server hands out a voice pass, and asks the
// voice service who is connected right now. Prints no keys. Run: node tools/voice-check.mjs
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const vars = Object.fromEntries(
  readFileSync(new URL('../worker/.dev.vars', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = vars;

// 1. Does the live game server give a newcomer a voice pass?
const welcome = await new Promise((resolve) => {
  const ws = new WebSocket('wss://notawork-space.notawork-space.workers.dev/ws');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: '(voice check)', color: '#3a86ff' }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'welcome' || m.t === 'denied') {
      ws.close();
      resolve(m);
    }
  };
  setTimeout(() => resolve(null), 8000);
});
if (!welcome || welcome.t !== 'welcome') {
  console.log('Could not join the live room:', welcome?.reason ?? 'no answer');
  process.exit(1);
}
console.log('People in the room:', welcome.players.filter((p) => p.id !== welcome.id).map((p) => `${p.name} [${p.id}]`).join(', ') || 'nobody');
console.log('Server hands out a voice pass:', welcome.media ? 'yes' : 'NO');

// 2. Who does the voice service say is connected, and what are they sending?
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: key, nbf: now - 10, exp: now + 60, video: { roomList: true, roomAdmin: true, room: 'notawork' } });
const jwt = body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
const call = async (method, payload) => {
  const r = await fetch(url.replace(/^wss:/, 'https:') + '/twirp/livekit.RoomService/' + method, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const rooms = await call('ListRooms', {});
console.log('Voice service answers:', rooms.status === 200 ? 'yes' : `NO (${rooms.status})`);
for (const room of rooms.data.rooms ?? []) {
  const people = await call('ListParticipants', { room: room.name });
  console.log(`Voice room "${room.name}": ${room.numParticipants ?? 0} connected`);
  for (const p of people.data.participants ?? []) {
    const tracks = (p.tracks ?? []).map((t) => `${String(t.source).toLowerCase()}${t.muted ? ' (muted)' : ''}`);
    console.log(`  ${p.name} [${p.identity}] ${String(p.state).toLowerCase()} · sending: ${tracks.join(', ') || 'nothing'}`);
  }
}
if (!(rooms.data.rooms ?? []).length) console.log('Nobody is connected to voice at the moment.');
