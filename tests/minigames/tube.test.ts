import { expect, test } from 'vitest';
import {
  TUBE_MAX_S,
  TUBE_RATE,
  TUBE_RATE_MS,
  newTube,
  parseTube,
  tubeAllow,
  tubeLeave,
  tubePause,
  tubePlay,
  tubePos,
  tubeResume,
  tubeSeek,
  tubeStop,
  tubeTick,
  tubeView,
} from '../../shared/minigames/tube';
import { create } from '../../worker/src/minigames/tube';
import type { GameIO } from '../../worker/src/minigames/api';
import type { PlayerInfo } from '../../shared/protocol';

const ID = 'dQw4w9WgXcQ';
const ID2 = 'a-b_c1D2e3F';
const ann = { id: 'a', name: 'Ann' };
const on = (now = 1000) => {
  const g = newTube();
  tubePlay(g, ann, ID, now);
  return g;
};

test('every accepted form of link gives the id', () => {
  for (const s of [
    ID,
    `  ${ID}\n`,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM`,
    `https://www.youtube.com/watch?feature=share&v=${ID}&t=42s`,
    `https://www.youtube.com/watch?v=${ID}#t=10`,
    `www.youtube.com/watch?v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=AbCdEf123&t=5`,
    `youtu.be/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/live/${ID}?si=xyz`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}?start=3`,
    `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`,
    `https://youtu.be/${ID}/`,
  ])
    expect(parseTube(s), s).toBe(ID);
  expect(parseTube(`https://youtu.be/${ID2}`)).toBe(ID2);
});

test('junk is refused', () => {
  for (const s of [
    '',
    '   ',
    'hello',
    'not a link at all',
    'https://example.com/',
    `https://example.com/watch?v=${ID}`,
    `https://vimeo.com/${ID}`,
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch?list=PL123',
    `https://www.youtube.com/playlist?v=${ID}`,
    `https://www.youtube.com/channel/${ID}`,
    `https://www.youtube.com/${ID}`,
    'https://youtu.be/',
    'x'.repeat(5000),
    null,
    undefined,
    42,
    {},
    [ID],
  ])
    expect(parseTube(s), String(s).slice(0, 60)).toBeNull();
});

test('ids with missing, extra or odd characters are refused', () => {
  for (const s of [
    ID.slice(0, 10),
    `${ID}x`,
    'dQw4w9WgXc!',
    'dQw4w9 gXcQ',
    'dQw4w9WgXc.',
    `https://youtu.be/${ID}x`,
    `https://youtu.be/${ID.slice(1)}`,
    `https://youtu.be/${ID}/more`,
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=${ID}%22`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 5)}`,
    `https://www.youtube.com/watch?v=<script>x`,
    `https://www.youtube.com/watch?v=${ID}"onload="x`,
    `https://www.youtube.com/watch/${ID}`,
    `https://www.youtube.com/watch/extra?v=${ID}`,
    `https://www.youtube.com/embed/${ID}/x`,
    `https://www.youtube.com/embed/${ID}%2F..`,
    `https://www.youtube.com/shorts/${ID}abc`,
    `https://www.youtube.com/live/`,
    `https://www.youtube.com/embed/../watch`,
  ])
    expect(parseTube(s), s).toBeNull();
});

test('tricky strings are refused', () => {
  for (const s of [
    'javascript:alert(1)',
    `javascript:alert('${ID}')`,
    `javascript://youtube.com/watch?v=${ID}`,
    `javascript://www.youtube.com/%0Aalert(1)//watch?v=${ID}`,
    `data:text/html,<script>alert(1)</script>`,
    `data:text/html,https://youtu.be/${ID}`,
    `file:///youtu.be/${ID}`,
    `ftp://youtu.be/${ID}`,
    `//youtu.be/${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `https://evil.example/youtube.com/watch?v=${ID}`,
    `https://evil.example/?u=https://youtu.be/${ID}`,
    `https://evil.example#https://youtu.be/${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtu.be.evil.example/${ID}`,
    `https://youtube.com@evil.example/watch?v=${ID}`,
    `https://user:pass@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `https://www.youtube.com\\@evil.example/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID} <img src=x>`,
    `https://youtu.be/${ID}\u0000`,
    `https://youtu.be/\t${ID}`,
    `https://www.youtube.com/redirect?q=https://evil.example&v=${ID}`,
    `https://www.youtube.com/watch?vv=${ID}`,
    `https://www.youtube.com/watch#v=${ID}`,
  ])
    expect(parseTube(s), s).toBeNull();
});

test('playing a link stores only the id, from the start, with who set it', () => {
  const g = newTube();
  expect(tubePlay(g, ann, 'https://evil.example/x', 0)).toBe(false);
  expect(g.id).toBeNull();
  expect(tubePlay(g, ann, `https://youtu.be/${ID}?si=tracking`, 5000)).toBe(true);
  expect(g).toMatchObject({ id: ID, playing: true, base: 0, at: 5000, by: ann });
  expect(JSON.stringify(tubeView(g, 5000))).not.toContain('tracking');
  expect(tubeView(g, 5000)).toEqual({ id: ID, playing: true, pos: 0, by: 'Ann' });
});

test('the position runs with the server clock while playing', () => {
  const g = on(1000);
  expect(tubePos(g, 1000)).toBe(0);
  expect(tubePos(g, 1000 + 2500)).toBe(2.5);
  expect(tubeView(g, 1000 + 61_000).pos).toBe(61);
  // A clock that steps backwards must not give a negative position.
  expect(tubePos(g, 500)).toBe(0);
});

test('pausing holds the position, and resuming carries on from it', () => {
  const g = on(0);
  expect(tubePause(g, 10_000)).toBe(true);
  expect(tubePause(g, 11_000)).toBe(false);
  expect(tubePos(g, 10_000)).toBe(10);
  expect(tubePos(g, 99_000)).toBe(10);
  expect(tubeView(g, 99_000)).toMatchObject({ playing: false, pos: 10 });
  expect(tubeResume(g, 100_000)).toBe(true);
  expect(tubeResume(g, 100_500)).toBe(false);
  expect(tubePos(g, 100_000)).toBe(10);
  expect(tubePos(g, 103_000)).toBe(13);
});

test('seeking jumps while playing or paused, and refuses nonsense', () => {
  const g = on(0);
  expect(tubeSeek(g, 120, 4000)).toBe(true);
  expect(tubePos(g, 4000)).toBe(120);
  expect(tubePos(g, 9000)).toBe(125);
  tubePause(g, 9000);
  expect(tubeSeek(g, 30.5, 20_000)).toBe(true);
  expect(tubePos(g, 50_000)).toBe(30.5);
  expect(g.playing).toBe(false);
  for (const t of [-1, NaN, Infinity, TUBE_MAX_S + 1, '30', null, undefined, {}]) expect(tubeSeek(g, t, 20_000), String(t)).toBe(false);
  expect(tubePos(g, 50_000)).toBe(30.5);
});

test('nothing but play works when nothing is on', () => {
  const g = newTube();
  expect(tubePause(g, 0)).toBe(false);
  expect(tubeResume(g, 0)).toBe(false);
  expect(tubeSeek(g, 5, 0)).toBe(false);
  expect(tubeStop(g)).toBe(false);
  expect(tubeView(g, 0)).toEqual({ id: null, playing: false, pos: 0, by: null });
});

test('stopping clears everything, and a new video starts from zero', () => {
  const g = on(0);
  tubeSeek(g, 500, 1000);
  expect(tubeStop(g)).toBe(true);
  expect(tubeView(g, 9000)).toEqual({ id: null, playing: false, pos: 0, by: null });
  tubePlay(g, { id: 'b', name: 'Bao' }, ID2, 10_000);
  expect(tubeView(g, 11_000)).toEqual({ id: ID2, playing: true, pos: 1, by: 'Bao' });
});

test('a video left running stops itself at the limit', () => {
  const g = on(0);
  expect(tubeTick(g, 60_000)).toBe(false);
  expect(tubePos(g, TUBE_MAX_S * 1000 + 5000)).toBe(TUBE_MAX_S);
  expect(tubeTick(g, TUBE_MAX_S * 1000)).toBe(true);
  expect(g.id).toBeNull();
});

test('the rate limit is per person and eases with time', () => {
  const g = newTube();
  for (let i = 0; i < TUBE_RATE; i++) expect(tubeAllow(g, 'a', i)).toBe(true);
  expect(tubeAllow(g, 'a', TUBE_RATE)).toBe(false);
  expect(tubeAllow(g, 'b', TUBE_RATE)).toBe(true);
  // Refused tries do not push the wait further out.
  expect(tubeAllow(g, 'a', TUBE_RATE_MS - 1)).toBe(false);
  expect(tubeAllow(g, 'a', TUBE_RATE_MS)).toBe(true);
  expect(tubeAllow(g, 'a', TUBE_RATE_MS)).toBe(false);
});

test('the video stops when the last person leaves, and Claude is not an audience', () => {
  const g = on(0);
  expect(tubeLeave(g, 'b', ['a', 'claude'])).toBe(false);
  expect(g.id).toBe(ID);
  expect(tubeLeave(g, 'a', ['claude'])).toBe(true);
  expect(g.id).toBeNull();
  // The same if the room still lists the person who is leaving.
  const h = on(0);
  expect(tubeLeave(h, 'a', ['a', 'claude'])).toBe(true);
  const k = on(0);
  expect(tubeLeave(k, 'a', [])).toBe(true);
  expect(tubeLeave(k, 'a', [])).toBe(false);
});

// ---- the server side, with a pretend room

function room() {
  const here: PlayerInfo[] = [];
  const sent: { to: string; view: any }[] = [];
  const io: GameIO = {
    players: () => here,
    send: (to, view) => sent.push({ to, view }),
    broadcast: (view) => sent.push({ to: '*', view }),
    notice: () => {},
    emote: () => {},
    put: () => {},
    nudge: () => {},
    resetBall: () => {},
    setScore: () => {},
  };
  const person = (id: string, name: string): PlayerInfo => {
    const p = { id, name, color: '#fff', look: 'a', x: 0, z: 0, ry: 0, seat: null };
    here.push(p);
    return p;
  };
  const game = create(io);
  return { game, sent, here, person, last: () => sent[sent.length - 1] };
}

test('server: a good link is broadcast as an id only, a bad one is refused privately', () => {
  const r = room();
  const a = r.person('a', 'Ann');
  r.person('b', 'Bao');
  r.game.onAction(a, { k: 'play', link: 'javascript:alert(1)' }, 0);
  expect(r.sent).toEqual([{ to: 'a', view: { id: null, playing: false, pos: 0, by: null, err: 'link' } }]);
  r.game.onAction(a, { k: 'play', link: `https://www.youtube.com/watch?v=${ID}&evil=<b>` }, 1000);
  expect(r.last()).toEqual({ to: '*', view: { id: ID, playing: true, pos: 0, by: 'Ann' } });
  expect(JSON.stringify(r.sent)).not.toContain('evil');
  // Hostile shapes do nothing at all.
  const n = r.sent.length;
  for (const bad of [{}, { k: 'play' }, { k: 'play', link: 7 }, { k: 'seek', t: 'x' }, { k: 'seek' }, { k: 'nope' }]) r.game.onAction(a, bad, 1500);
  expect(r.sent.slice(n).every((m) => m.to === 'a' || m.to === '*')).toBe(true);
  expect(r.sent.slice(n).filter((m) => m.to === '*')).toEqual([]);
});

test('server: anyone may pause, seek, resume and stop, and each change goes to everyone', () => {
  const r = room();
  const a = r.person('a', 'Ann');
  const b = r.person('b', 'Bao');
  r.game.onAction(a, { k: 'play', link: ID }, 0);
  r.game.onAction(b, { k: 'pause' }, 8000);
  expect(r.last()).toEqual({ to: '*', view: { id: ID, playing: false, pos: 8, by: 'Ann' } });
  r.game.onAction(b, { k: 'seek', t: 60 }, 9000);
  expect(r.last().view).toMatchObject({ playing: false, pos: 60 });
  r.game.onAction(a, { k: 'resume' }, 20_000);
  expect(r.last().view).toMatchObject({ playing: true, pos: 60 });
  r.game.onAction(b, { k: 'stop' }, 30_000);
  expect(r.last()).toEqual({ to: '*', view: { id: null, playing: false, pos: 0, by: null } });
});

test('server: a newcomer is sent the position as it is now, and nothing when nothing is on', () => {
  const r = room();
  const a = r.person('a', 'Ann');
  const c = r.person('c', 'Chi');
  r.game.onJoin!(c, 0);
  expect(r.sent).toEqual([]);
  r.game.onAction(a, { k: 'play', link: ID }, 0);
  r.game.onJoin!(c, 45_000);
  expect(r.last()).toEqual({ to: 'c', view: { id: ID, playing: true, pos: 45, by: 'Ann' } });
});

test('server: going too fast is refused privately and changes nothing', () => {
  const r = room();
  const a = r.person('a', 'Ann');
  const b = r.person('b', 'Bao');
  r.game.onAction(a, { k: 'play', link: ID }, 0);
  for (let i = 1; i < TUBE_RATE; i++) r.game.onAction(a, { k: 'seek', t: i }, i);
  r.game.onAction(a, { k: 'stop' }, 100);
  expect(r.last()).toMatchObject({ to: 'a', view: { id: ID, err: 'slow' } });
  // Someone else is not held back by it.
  r.game.onAction(b, { k: 'pause' }, 200);
  expect(r.last()).toMatchObject({ to: '*', view: { playing: false } });
});

test('server: the video stops when the room empties', () => {
  const r = room();
  const a = r.person('a', 'Ann');
  const b = r.person('b', 'Bao');
  r.person('claude', 'Claude');
  r.game.onAction(a, { k: 'play', link: ID }, 0);
  r.here.splice(r.here.indexOf(b), 1);
  const n = r.sent.length;
  r.game.onLeave('b', 1000);
  expect(r.sent.length).toBe(n);
  r.here.splice(r.here.indexOf(a), 1);
  r.game.onLeave('a', 2000);
  expect(r.last().view).toMatchObject({ id: null });
  const d = r.person('d', 'Dung');
  const m = r.sent.length;
  r.game.onJoin!(d, 3000);
  expect(r.sent.length).toBe(m);
});
