import { DuelUI } from './duel';
import { DUEL_REACH } from '../shared/duel';
import { NPC_ID } from '../shared/fun';
import type { ChessView } from '../shared/tables';
import * as THREE from 'three';
import { MAX_KICK, MAX_LIFT } from '../shared/ball';
import { sceneColliders, showColliders } from './collide';
import { confetti, flash, play } from './fun';
import { EMOJI } from '../shared/fun';
import type { Collider } from '../shared/layout';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';
import { COLORS, TICK_HZ, type ClientMsg, type PlayerInfo, type ServerMsg, LOOKS } from '../shared/protocol';
import {
  BOUNDS,
  GRID_GROUPS,
  RACE,
  RACE_R,
  SCREEN,
  SEATS,
  SPOTS,
  STATIONS,
  seatGroup,
  type Seat,
  type Spot,
  type Station,
} from '../shared/layout';
import { BALL_R } from '../shared/ball';
import { Games } from './games';
import { TableUI } from './tables';
import { isTable } from '../shared/tables';
import { seatLabel } from '../shared/layout';
import { ING_LABEL, RECIPES } from '../shared/kitchen';
import { buildWorld } from './world';
import { Avatar } from './avatar';
import { KitchenView } from './kitchen';
import { Media, type Near } from './media';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Browser storage can be unavailable (private windows), so never rely on it.
const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* fine */
    }
  },
};

// ---------------------------------------------------------------- scene

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Neutral tone mapping keeps camera feeds and the cinema screen looking natural.
renderer.toneMapping = THREE.NeutralToneMapping;

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);
const world = buildWorld();
const kitchen = new KitchenView(world.scene);
const games = new Games(world.scene);
// Everything solid in the scenery, worked out once before any people are added.
const solid = sceneColliders(world.scene);

// Bloom: only things brighter than white glow (lanterns, fire, neon, string lights).
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }),
);
composer.addPass(new RenderPass(world.scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.6, 1.0));
composer.addPass(new OutputPass());

/** How many real pixels are drawn per screen pixel. Lowered automatically on slow machines (see adaptQuality). */
let scale = Math.min(devicePixelRatio, 2);

function resize() {
  renderer.setPixelRatio(scale);
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- state

const avatars = new Map<string, Avatar>();
const cams = new Map<string, HTMLVideoElement>();
let me: Avatar | null = null;
let myId = '';
let ws: WebSocket | null = null;
let media: Media | null = null;
let speaking = new Set<string>();

const keys = new Set<string>();
// What the camera is doing now, and (the "want" values) where your dragging and scrolling have asked it to be.
let camYaw = 0;
let camPitch = 0.42;
let camDist = 12;
let wantYaw = camYaw;
let wantPitch = camPitch;
let wantDist = camDist;
let shownDist = 12;
const camFocus = new THREE.Vector3(0, 1.6, 13);

const send = (msg: ClientMsg) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
};

// ---------------------------------------------------------------- interface bits

const chatLog = $('chat-log');
const chatInput = $<HTMLInputElement>('chat-input');
const promptEl = $('prompt');
const toastEl = $('toast');
const menuEl = $('menu');
const gridEl = $('grid');
const gridTiles = $('grid-tiles');
const theaterEl = $('theater');
const btnMic = $<HTMLButtonElement>('btn-mic');
const btnCam = $<HTMLButtonElement>('btn-cam');
const btnShare = $<HTMLButtonElement>('btn-share');
const btnTheater = $<HTMLButtonElement>('btn-theater');

function logLine(text: string, who?: { name: string; color: string }) {
  const line = document.createElement('div');
  if (who) {
    const name = document.createElement('span');
    name.className = 'who';
    name.style.color = who.color;
    name.textContent = who.name;
    line.append(name, text);
  } else {
    line.className = 'system';
    line.textContent = text;
  }
  chatLog.append(line);
  while (chatLog.childElementCount > 60) chatLog.firstElementChild!.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

let toastTimer = 0;
function toast(text: string, sticky = false) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = window.setTimeout(() => (toastEl.hidden = true), 3800);
}

function updateOnline() {
  $('online').textContent = avatars.size === 1 ? 'Just you here' : `${avatars.size} here`;
  if (!peopleEl.hidden) renderPeople();
}

// Who is here: hover over (or click) the count to see everyone and what they're up to.
const peopleEl = $('people');
const WHERE: Record<string, string> = {
  lounge: 'by the fire',
  dining: 'at the dining table',
  cinema: 'at the cinema',
  chess: 'at the chess table',
  cards: 'playing Last Card',
  poker: 'at the poker table',
  wolf: 'playing Werewolf',
  pho: 'playing Phố Lớn',
};
function renderPeople() {
  // You first, then everyone else by name.
  const list = [...avatars.values()].sort((a, b) => Number(b.info.id === myId) - Number(a.info.id === myId) || a.info.name.localeCompare(b.info.name));
  peopleEl.replaceChildren(
    ...list.map((a) => {
      const row = document.createElement('div');
      row.className = 'person';
      const dot = document.createElement('i');
      dot.style.background = a.info.color;
      const name = document.createElement('b');
      name.textContent = a.info.id === myId ? `${a.info.name} (you)` : a.info.name;
      const doing = document.createElement('span');
      const group = seatGroup(a.seat);
      doing.textContent = `${a.speaking ? '🔊 ' : ''}${duelUI.busy(a.info.id) ? 'in a duel' : group ? (WHERE[group] ?? 'sitting down') : 'walking around'}`;
      row.append(dot, name, doing);
      return row;
    }),
  );
}
let peoplePinned = false;
function showPeople(show: boolean) {
  peopleEl.hidden = !show;
  $('online').setAttribute('aria-expanded', String(show));
  if (show) renderPeople();
}
{
  const who = $('who');
  who.addEventListener('pointerenter', () => showPeople(true));
  who.addEventListener('pointerleave', () => !peoplePinned && showPeople(false));
  // Clicking pins it open (handy on touch screens, where there is no hover).
  $('online').onclick = () => {
    peoplePinned = !peoplePinned;
    showPeople(peoplePinned);
  };
  setInterval(() => !peopleEl.hidden && renderPeople(), 1000);
}

function renderMenu() {
  menuEl.replaceChildren();
  const h = document.createElement('h2');
  h.textContent = 'On the menu';
  const ul = document.createElement('ul');
  for (const r of RECIPES) {
    const li = document.createElement('li');
    const parts = document.createElement('span');
    parts.textContent = ' — ' + r.items.map((i) => ING_LABEL[i]).join(', ');
    li.append(r.name, parts);
    ul.append(li);
  }
  const tally = document.createElement('p');
  tally.className = 'tally';
  tally.textContent = `Dishes served: ${kitchen.state?.total ?? 0}`;
  const tip = document.createElement('p');
  tip.style.margin = '6px 0 0';
  tip.style.color = 'var(--muted)';
  tip.textContent = 'Chop tomato and lettuce. Cook patty and egg. No rush.';
  menuEl.append(h, ul, tally, tip);
}

// ---------------------------------------------------------------- players

function addAvatar(info: PlayerInfo) {
  if (avatars.has(info.id)) return;
  const a = new Avatar(info);
  avatars.set(info.id, a);
  world.scene.add(a.group);
  const cam = cams.get(info.id);
  if (cam) a.setVideo(cam);
  updateOnline();
}

function removeAvatar(id: string) {
  const a = avatars.get(id);
  if (!a) return;
  a.dispose();
  avatars.delete(id);
  updateOnline();
}

const seatById = new Map(SEATS.map((s) => [s.id, s]));

/** The face-grid group I'm sitting in, if any. */
const myGridGroup = () => {
  const g = seatGroup(me?.seat ?? null);
  return g && GRID_GROUPS.includes(g) ? g : null;
};

// ---------------------------------------------------------------- face grid (sitting down)

const tableViews = new Map<string, unknown>();
const tableUI = new TableUI($('game'), (table, a) => send({ t: 'game', table, a }));

const gridVideos: HTMLVideoElement[] = [];
const gridTileById = new Map<string, HTMLElement>();

function renderGrid() {
  for (const el of gridVideos) media?.release(el);
  gridVideos.length = 0;
  gridTileById.clear();
  gridTiles.replaceChildren();

  const group = myGridGroup();
  gridEl.hidden = !group;
  // Chat sits on top of the sit-down panel, so give it a solid backing there to stay readable.
  $('chat').classList.toggle('over-panel', !!group);
  // At a game table the game takes the main area and faces move to a side column.
  gridEl.classList.toggle('game', isTable(group));
  if (isTable(group)) tableUI.show(group, tableViews.get(group));
  else tableUI.clear();
  if (!group) return;

  for (const a of avatars.values()) {
    if (seatGroup(a.seat) !== group) continue;
    const tile = document.createElement('div');
    tile.className = 'tile';
    const video = media?.attachCamera(a.info.id) ?? null;
    if (video) {
      video.muted = true;
      video.playsInline = true;
      if (a.info.id === myId) video.classList.add('mirror'); // your own picture, as in a mirror
      gridVideos.push(video);
      tile.append(video);
    } else {
      const initial = document.createElement('div');
      initial.className = 'initial';
      initial.style.background = a.info.color;
      initial.textContent = a.info.name.slice(0, 1).toUpperCase();
      tile.append(initial);
    }
    const name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = a.info.id === myId ? `${a.info.name} (you)` : a.info.name;
    tile.append(name);
    tile.classList.toggle('speaking', speaking.has(a.info.id));
    gridTileById.set(a.info.id, tile);
    gridTiles.append(tile);
  }
}

// ---------------------------------------------------------------- theater (full-screen viewing)

let theaterVideo: HTMLVideoElement | null = null;

function closeTheater() {
  if (theaterVideo) media?.release(theaterVideo);
  theaterVideo = null;
  theaterEl.hidden = true;
}

function openTheater() {
  closeTheater();
  const el = media?.attachScreen();
  if (!el) return;
  el.muted = true; // sound comes from the shared audio track
  el.playsInline = true;
  theaterVideo = el;
  theaterEl.prepend(el);
  theaterEl.hidden = false;
  // It was created off the page, where some browsers refuse to start it; start it now that it is shown.
  void el.play().catch(() => {});
}

btnTheater.onclick = openTheater;
$('theater-close').onclick = closeTheater;

// ---------------------------------------------------------------- voice, video, screenshare

function refreshMediaButtons() {
  if (!media) return;
  btnTheater.hidden = !media.hasScreen;
  btnShare.textContent = media.sharingMyScreen ? 'Stop sharing' : 'Share screen';
  btnShare.classList.toggle('on', media.sharingMyScreen);
}

// Bumped whenever the room connection is replaced, so a voice connection still starting for the
// old one can tell it is no longer wanted.
let mediaRound = 0;

async function startMedia(url: string, token: string) {
  const round = ++mediaRound;
  const m = new Media(myId, {
    camera(id, el) {
      if (el) cams.set(id, el);
      else cams.delete(id);
      avatars.get(id)?.setVideo(el);
    },
    screen(el) {
      world.setScreenVideo(el);
      if (!el) closeTheater();
      else if (!theaterEl.hidden) openTheater();
    },
    speaking(ids) {
      speaking = ids;
      for (const [id, a] of avatars) a.setSpeaking(ids.has(id));
      // Your own Mic button glows while the room can hear you, so you know your voice is getting through.
      btnMic.classList.toggle('heard', ids.has(myId));
      for (const [id, tile] of gridTileById) tile.classList.toggle('speaking', ids.has(id));
    },
    changed() {
      refreshMediaButtons();
      renderGrid();
    },
    lost() {
      media = null;
      for (const b of [btnMic, btnCam, btnShare, btnTheater]) b.hidden = true;
      logLine('Voice and video dropped. Reload the page to get them back.');
    },
  });
  try {
    await m.connect(url, token);
    if (round !== mediaRound) {
      void m.close();
      return;
    }
    media = m;
    for (const b of [btnMic, btnCam, btnShare]) b.hidden = false;
  } catch (err) {
    console.error(err);
    logLine('Voice and video could not connect. Chat and the room still work.');
  }
}

function wireToggle(btn: HTMLButtonElement, on: string, off: string, action: () => Promise<boolean>) {
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const enabled = await action();
      btn.textContent = enabled ? on : off;
      btn.classList.toggle('on', enabled);
    } catch (err) {
      console.error(err);
      toast('That was blocked. Check the browser permission and try again.');
    }
    btn.disabled = false;
    refreshMediaButtons();
  };
}
// Mic: click the button or press M to leave it on; hold V to talk only while held.
let micLatched = false;
let talkHeld = false;
let micQueue: Promise<void> = Promise.resolve();
function applyMic() {
  if (!media) {
    // Voice hasn't connected yet: don't remember a press that did nothing.
    micLatched = talkHeld = false;
    return;
  }
  btnMic.textContent = micLatched ? 'Mic on' : talkHeld ? 'Talking…' : 'Mic off · hold V';
  btnMic.classList.toggle('on', micLatched || talkHeld);
  // Run changes one after another so a quick press and release can't end up out of order.
  micQueue = micQueue.then(async () => {
    try {
      await media!.setMic(micLatched || talkHeld);
    } catch (err) {
      console.error(err);
      micLatched = talkHeld = false;
      btnMic.textContent = 'Mic off · hold V';
      btnMic.classList.remove('on');
      toast('The microphone was blocked. Check the browser permission and try again.');
    }
  });
}
btnMic.textContent = 'Mic off · hold V';
btnMic.onclick = () => {
  micLatched = !micLatched;
  applyMic();
};
wireToggle(btnCam, 'Camera on', 'Camera off', () => media!.toggleCamera());
btnShare.onclick = async () => {
  if (media!.hasScreen && !media!.sharingMyScreen) {
    toast('Someone is already sharing. Ask them to stop first.');
    return;
  }
  try {
    const on = await media!.toggleScreen();
    if (on && !media!.sharingSound) toast('Sharing without sound. To share sound, use Chrome or Edge and pick a tab.');
  } catch (err) {
    console.error(err); // usually just the person cancelling the picker
  }
  refreshMediaButtons();
};
for (const b of [btnMic, btnCam, btnShare]) b.hidden = true;

// ---------------------------------------------------------------- network

let lastScoreTotal = 0;
const duelUI = new DuelUI(world.scene, avatars, () => myId, (m) => send(m));

// Playing chess against the built-in Claude character: its moves are worked out here, in the
// browser of whoever is sitting opposite, and sent to the server (which checks they are legal).
let chessBrain: Worker | null = null;
let thinkingAbout = '';
function thinkForClaude(v: ChessView) {
  const turn = v.fen.split(' ')[1];
  if (!v.bot || !v.you || v.you === v.bot || v.status !== 'playing' || turn !== v.bot || thinkingAbout === v.fen) return;
  thinkingAbout = v.fen;
  const asked = performance.now();
  chessBrain ??= new Worker(new URL('./chess-worker.ts', import.meta.url), { type: 'module' });
  chessBrain.onmessage = (e: MessageEvent<{ fen: string; move: { from: string; to: string } | null }>) => {
    const { fen, move } = e.data;
    if (!move || fen !== thinkingAbout) return;
    // Never instant: a short pause reads as thought.
    window.setTimeout(() => send({ t: 'game', table: 'chess', a: { k: 'bot', from: move.from, to: move.to } }), Math.max(0, 900 - (performance.now() - asked)));
  };
  chessBrain.postMessage({ fen: v.fen });
}

function handle(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome': {
      myId = msg.id;
      for (const p of msg.players) addAvatar(p);
      me = avatars.get(myId)!;
      me.local = true;
      camFocus.set(me.x, 1.6, me.z);
      kitchen.setState(msg.kitchen, avatars);
      world.setBoard(msg.board);
      games.setAll(msg.games);
      lastScoreTotal = msg.games.score[0] + msg.games.score[1];
      if (msg.work) world.setWork(Date.now() - msg.work.ago, msg.work.by);
      for (const d of msg.duels ?? []) duelUI.update(d);
      renderMenu();
      $('join').hidden = true;
      $('hud').hidden = false;
      everJoined = true;
      retries = 0;
      if (backTo) {
        // Reconnected: put me back where I was standing.
        me.place(backTo.x, backTo.z, backTo.ry);
        camFocus.set(me.x, 1.6, me.z);
        sent.x = sent.z = sent.ry = Infinity;
        backTo = null;
        toastEl.hidden = true;
        logLine('Back in the room.');
      } else logLine('You came in. Press Enter to chat, H for the guide.');
      if (msg.media) void startMedia(msg.media.url, msg.media.token);
      else logLine('Voice and video are not set up on this server yet.');
      break;
    }
    case 'denied':
      if (everJoined) {
        // Refused while reconnecting: nothing more to try automatically.
        everJoined = false;
        toast(msg.reason === 'password' ? 'The room password has changed. Reload the page.' : 'The room filled up while you were away. Reload to try again.', true);
      } else joinFailed(msg.reason === 'password' ? 'That password is not right.' : 'The room is full right now.');
      break;
    case 'join':
      addAvatar(msg.player);
      logLine(`${msg.player.name} came in`);
      break;
    case 'leave': {
      const a = avatars.get(msg.id);
      if (a) logLine(`${a.info.name} left`);
      removeAvatar(msg.id);
      cams.delete(msg.id);
      renderGrid();
      break;
    }
    case 'state':
      for (const [id, x, z, ry] of msg.players) if (id !== myId) avatars.get(id)?.setTarget(x, z, ry);
      break;
    case 'sit': {
      const a = avatars.get(msg.id);
      if (!a) break;
      a.seat = msg.seat;
      const seat = msg.seat ? seatById.get(msg.seat) : null;
      if (seat) a.place(seat.x, seat.z, seat.ry);
      renderGrid();
      break;
    }
    case 'chat': {
      const a = avatars.get(msg.id);
      logLine(msg.text, { name: msg.name, color: a?.info.color ?? '#fff' });
      a?.say(msg.text);
      break;
    }
    case 'kitchen':
      kitchen.setState(msg.state, avatars);
      renderMenu();
      break;
    case 'notice':
      toast(msg.text);
      logLine(msg.text);
      if (/\b(won|wins|new record)\b/i.test(msg.text)) {
        confetti();
        play('tada');
      }
      break;
    case 'duel':
      duelUI.update(msg.duel, msg.id);
      break;
    case 'duelAsk':
      duelUI.ask(msg.from, msg.name);
      break;
    case 'emote':
      avatars.get(msg.id)?.emote(msg.k);
      if (msg.k !== 'zzz' && msg.id !== myId) play('pop');
      break;
    case 'work': {
      world.setWork(Date.now(), msg.by);
      flash();
      play('alarm');
      const line = `🚨 Work talk detected: “${msg.word}”. ${msg.by} owes the room a round.`;
      toast(line);
      logLine(line);
      for (const a of avatars.values()) if (a.info.name === msg.by) a.emote('🚨');
      break;
    }
    case 'board':
      world.setBoard(msg.board);
      break;
    case 'table':
      tableViews.set(msg.table, msg.view);
      if (msg.table === 'chess') thinkForClaude(msg.view as ChessView);
      if (myGridGroup() === msg.table && isTable(msg.table)) tableUI.show(msg.table, msg.view);
      break;
    case 'ball':
      games.syncBall(msg.ball);
      break;
    case 'score':
      if (msg.score[0] + msg.score[1] > lastScoreTotal) {
        confetti(['⚽', '🎉', '🥅', '✨']);
        play('horn');
      }
      lastScoreTotal = msg.score[0] + msg.score[1];
      games.setScore(msg.score);
      break;
    case 'laps':
      games.setLaps(msg.laps);
      break;
    case 'wheel':
      games.spinWheel(msg.names, msg.winner, performance.now() / 1000);
      break;
  }
}

// ---------------------------------------------------------------- joining

const joinForm = $<HTMLFormElement>('join-form');
const nameInput = $<HTMLInputElement>('name');
const passwordInput = $<HTMLInputElement>('password');
const joinButton = $<HTMLButtonElement>('join-button');
const joinError = $('join-error');
let color = store.get('color') ?? COLORS[Math.floor(Math.random() * COLORS.length)];
if (!COLORS.includes(color)) color = COLORS[0];

const swatches = $('swatches');
for (const c of COLORS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.style.background = c;
  b.setAttribute('aria-label', `Colour ${COLORS.indexOf(c) + 1}`);
  b.onclick = () => {
    color = c;
    paintSwatches();
  };
  swatches.append(b);
}
function paintSwatches() {
  [...swatches.children].forEach((el, i) => el.classList.toggle('picked', COLORS[i] === color));
}
paintSwatches();

// Character picker: everyone chooses who they are. A first-time visitor starts on a random one.
let look = store.get('look') ?? '';
if (!LOOKS.includes(look)) look = LOOKS[Math.floor(Math.random() * LOOKS.length)];
const looksEl = $('looks');
for (const l of LOOKS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'look';
  b.setAttribute('aria-label', `${l.startsWith('female') ? 'Woman' : 'Man'} ${l.slice(-1).toUpperCase()}`);
  const img = document.createElement('img');
  img.src = `${import.meta.env.BASE_URL}characters/previews/${l}.png`;
  img.alt = '';
  b.append(img);
  b.dataset.look = l;
  b.onclick = () => {
    look = l;
    paintLooks();
  };
  // Women on the first row, men on the second, each with a small heading.
  const row = l.startsWith('female') ? 'Women' : 'Men';
  let group = looksEl.querySelector<HTMLElement>(`[data-row="${row}"]`);
  if (!group) {
    group = document.createElement('div');
    group.className = 'look-row';
    group.dataset.row = row;
    const heading = document.createElement('span');
    heading.textContent = row;
    group.append(heading);
    looksEl.append(group);
  }
  group.append(b);
}
function paintLooks() {
  for (const el of looksEl.querySelectorAll<HTMLElement>('.look')) {
    el.classList.toggle('picked', el.dataset.look === look);
    el.setAttribute('aria-pressed', String(el.dataset.look === look));
  }
}
paintLooks();
nameInput.value = store.get('name') ?? '';
nameInput.focus();

function joinFailed(text: string) {
  joinError.textContent = text;
  joinError.hidden = false;
  joinButton.disabled = false;
  $('join').hidden = false;
}

const SERVER = (import.meta.env.VITE_SERVER_URL ?? '').replace(/\/$/, '');
const wsUrl = SERVER
  ? SERVER.replace(/^http/, 'ws') + '/ws'
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

joinForm.onsubmit = (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  store.set('name', name);
  store.set('color', color);
  store.set('look', look);
  joinError.hidden = true;
  joinButton.disabled = true;

  joinName = name;
  connect();
};

let joinName = '';
/** True once I have been in the room, so a dropped connection means "reconnect", not "couldn't join". */
let everJoined = false;
let retries = 0;
/** Where I was standing when the connection dropped. */
let backTo: { x: number; z: number; ry: number } | null = null;

function connect() {
  const socket = new WebSocket(wsUrl);
  ws = socket;
  socket.onopen = () => send({ t: 'join', name: joinName, color, look, password: passwordInput.value || undefined });
  socket.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string));
    } catch (err) {
      console.error('bad message', err);
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    if (everJoined) lostRoom();
    else if (joinError.hidden) joinFailed('Could not reach the room. Try again in a moment.');
  };
}

/**
 * The room connection dropped (wifi blip, laptop sleep, server restart). Clear out what belonged to
 * it and keep trying to get back in; you return as a new arrival standing where you were.
 */
function lostRoom() {
  if (me) backTo = { x: me.x, z: me.z, ry: me.ry };
  me = null;
  myId = '';
  for (const id of [...avatars.keys()]) removeAvatar(id);
  cams.clear();
  duelUI.clear();
  tableViews.clear();
  mediaRound++;
  const old = media;
  media = null;
  void old?.close();
  micLatched = talkHeld = false;
  btnMic.textContent = 'Mic off · hold V';
  btnMic.classList.remove('on');
  btnCam.textContent = 'Camera off';
  btnCam.classList.remove('on');
  for (const b of [btnMic, btnCam, btnShare, btnTheater]) b.hidden = true;
  world.setScreenVideo(null);
  closeTheater();
  renderGrid();
  keys.clear();
  velX = velZ = 0;
  const wait = Math.min(10_000, 1000 * 2 ** Math.min(retries, 4));
  retries++;
  toast(retries > 1 ? `Still reconnecting… (try ${retries})` : 'Connection lost. Reconnecting…', true);
  window.setTimeout(connect, wait);
}

// ---------------------------------------------------------------- input

chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  // Enter that confirms a Vietnamese (or other) input-method composition must not send the message.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text) send({ t: 'chat', text });
    chatInput.value = '';
    chatInput.blur();
  } else if (e.key === 'Escape') {
    chatInput.blur();
  }
});

interface Target {
  station?: Station;
  seat?: Seat;
  spot?: Spot;
}

function nearest(): Target | null {
  if (!me) return null;
  let best: Target | null = null;
  let bestD = Infinity;
  for (const station of STATIONS) {
    const d = Math.hypot(station.x - me.x, station.z - me.z);
    if (d < 2.3 && d < bestD) {
      best = { station };
      bestD = d;
    }
  }
  for (const spot of SPOTS) {
    const d = Math.hypot(spot.x - me.x, spot.z - me.z);
    if (d < 2.6 && d < bestD) {
      best = { spot };
      bestD = d;
    }
  }
  const taken = new Set([...avatars.values()].map((a) => a.seat));
  for (const seat of SEATS) {
    if (taken.has(seat.id)) continue;
    const d = Math.hypot(seat.x - me.x, seat.z - me.z);
    if (d < 1.7 && d < bestD) {
      best = { seat };
      bestD = d;
    }
  }
  return best;
}

function promptFor(t: Target): string {
  if (t.seat) return `E — ${seatLabel(t.seat.id)}`;
  if (t.spot) {
    if (t.spot.id === 'wheel') return 'E — spin the wheel';
    if (t.spot.id === 'score') return 'E — reset the score to 0 – 0';
    return race ? '' : 'E — start a timed lap';
  }
  const st = t.station!;
  const held = kitchen.state?.held[myId] ?? null;
  const holding = !!held;
  switch (st.type) {
    case 'crate':
      return holding ? `E — put back the ${ING_LABEL[st.ing!]}` : `E — take a ${ING_LABEL[st.ing!]}`;
    case 'plates':
      return holding ? 'E — put the plate back' : 'E — take a plate';
    case 'bin':
      return holding ? 'E — throw it away' : '';
    case 'hatch':
      return held?.k === 'plate' && held.c.length ? 'E — serve the plate' : 'Bring a plate of food here to serve it';
    case 'board':
      return 'E — put down or pick up · F — chop';
    case 'stove':
      return 'E — cook, or take it off';
    default:
      return 'E — put down or pick up';
  }
}

function interact() {
  if (!me) return;
  if (me.seat) {
    send({ t: 'sit', seat: null });
    return;
  }
  const t = nearest();
  if (t?.seat) send({ t: 'sit', seat: t.seat.id });
  else if (t?.spot?.id === 'race') startRace();
  else if (t?.spot) send({ t: 'spot', id: t.spot.id });
  else if (t?.station) send({ t: 'use', station: t.station.id });
}

addEventListener('keydown', (e) => {
  // macOS never sends keyup for a key released while Cmd is down, so let go of everything.
  if (e.metaKey) {
    keys.clear();
    releaseTalk();
  }
  if (!me || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  // With the guide open, only the keys that close it do anything.
  if (!guideEl.hidden && e.code !== 'KeyH' && e.code !== 'Escape') return;
  switch (e.code) {
    case 'Enter':
      if (e.target instanceof HTMLButtonElement) return; // let Enter press the focused button
      e.preventDefault();
      chatInput.focus();
      return;
    case 'KeyE':
      if (!e.repeat) interact();
      return;
    case 'KeyF': {
      const t = nearest();
      if (!e.repeat && t?.station?.type === 'board') send({ t: 'act', station: t.station.id });
      return;
    }
    case 'KeyV':
      if (!e.repeat && !talkHeld) {
        talkHeld = true;
        applyMic();
      }
      return;
    case 'KeyG':
      if (!e.repeat) challenge();
      return;
    case 'KeyY':
    case 'KeyN':
      if (duelUI.asking) duelUI.answer(e.code === 'KeyY');
      return;
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
      // In a duel, 1 to 3 choose your move.
      if (!e.repeat && duelUI.key(+e.code.slice(5))) return;
      if (!e.repeat) emote(EMOJI[+e.code.slice(5) - 1]);
      return;
    case 'Digit4':
    case 'Digit5':
    case 'Digit6':
      if (!e.repeat) emote(EMOJI[+e.code.slice(5) - 1]);
      return;
    case 'Digit7':
      if (!e.repeat) emote('dance');
      return;
    case 'KeyM':
      if (!e.repeat) {
        micLatched = !micLatched;
        applyMic();
      }
      return;
    case 'Space':
      e.preventDefault();
      if (!e.repeat) shoot();
      return;
    case 'KeyI':
      if (!e.repeat) toggleInfo();
      return;
    case 'KeyH':
      if (!e.repeat) toggleGuide();
      return;
    case 'Escape':
      closeTheater();
      toggleGuide(false);
      return;
  }
  keys.add(e.code);
});
// Info panel (press I): which version this browser runs and what the voice and share links are
// doing. Made for screenshots when something looks wrong.
const infoEl = $('info');
let infoTimer = 0;
let fpsCount = 0;
async function refreshInfo() {
  const fps = fpsCount / 2;
  fpsCount = 0;
  const lines = [
    `Version: ${__BUILD__}`,
    `Browser: ${navigator.userAgent.match(/(Firefox|Edg|OPR|Chrome|Safari)\/[\d.]+/)?.[0].replace('Edg', 'Edge') ?? navigator.userAgent}`,
    `Room connection: ${ws?.readyState === WebSocket.OPEN ? 'open' : 'CLOSED'} · ${avatars.size} here`,
    `3D picture: ${Math.round(fps)} fps at ${Math.round((scale / MAX_SCALE) * 100)}% sharpness`,
    ...(media ? await media.info() : ['Voice connection: not connected']),
  ];
  infoEl.textContent = lines.join('\n');
}
function toggleInfo() {
  infoEl.hidden = !infoEl.hidden;
  clearInterval(infoTimer);
  if (!infoEl.hidden) {
    infoEl.textContent = 'Measuring…';
    fpsCount = 0;
    infoTimer = window.setInterval(() => void refreshInfo(), 2000);
  }
}

// The full guide. The bottom line keeps only the keys you need all the time.
const guideEl = $('guide');
function toggleGuide(open = guideEl.hidden) {
  guideEl.hidden = !open;
  if (open) {
    keys.clear();
    releaseTalk();
    $('guide-close').focus();
  }
}
$('btn-guide').onclick = () => toggleGuide();
$('guide-close').onclick = () => toggleGuide(false);
guideEl.addEventListener('pointerdown', (e) => {
  if (e.target === guideEl) toggleGuide(false); // click outside the card
});

/** The closest other person within duelling distance who is free to fight. */
function duelTarget() {
  if (!me || me.seat || duelUI.mine()) return null;
  let best: Avatar | null = null;
  let bestD = DUEL_REACH;
  for (const a of avatars.values()) {
    if (a === me || a.seat || a.info.id === NPC_ID || duelUI.busy(a.info.id)) continue;
    const d = Math.hypot(a.x - me.x, a.z - me.z);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best;
}
function challenge() {
  const t = duelTarget();
  if (t) send({ t: 'duel', a: 'challenge', to: t.info.id });
}

function emote(k: string) {
  send({ t: 'emote', k });
  if (k !== 'zzz') play('pop');
}
// Nod off after two minutes without touching anything.
let lastInput = Date.now();
for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) addEventListener(type, () => (lastInput = Date.now()), { passive: true });
setInterval(() => {
  if (me && Date.now() - lastInput > 120_000) emote('zzz');
}, 6000);

function releaseTalk() {
  if (!talkHeld) return;
  talkHeld = false;
  applyMic();
}
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'KeyV') releaseTalk();
});
addEventListener('blur', () => {
  keys.clear();
  releaseTalk();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    keys.clear();
    releaseTalk();
  }
});
// Keep-alive on a timer, not in the render loop: browsers pause rendering in a hidden tab,
// and the server drops anyone it hasn't heard from for a minute.
setInterval(() => {
  if (me) send({ t: 'ping' });
}, 20_000);

// Drag to orbit, scroll to zoom.
let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  wantYaw -= e.movementX * 0.005;
  wantPitch = Math.max(0.12, Math.min(1.35, wantPitch + e.movementY * 0.004));
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    wantDist = Math.max(4, Math.min(26, wantDist + e.deltaY * 0.012));
  },
  { passive: false },
);

// ---------------------------------------------------------------- movement

const EDGE = 0.7;
const BODY = 0.38;
const WALK = 5.5;
const RUN = 8.5;

// Lap race: gates must be passed in order, ending back at the start.
const RACE_ORDER = [...RACE.keys()].slice(1).concat(0);
let race: { start: number; step: number } | null = null;
const timerEl = $('timer');

function startRace() {
  if (race) return;
  race = { start: performance.now(), step: 0 };
  games.setNextGate(RACE_ORDER[0]);
  toast('Go! Run through the glowing gates. Hold Shift to run.');
}

function endRace(finished: boolean) {
  if (!race) return;
  if (finished) send({ t: 'lap', ms: Math.round(performance.now() - race.start) });
  race = null;
  games.setNextGate(null);
  timerEl.hidden = true;
}

function tickRace() {
  if (!race || !me) return;
  const elapsed = performance.now() - race.start;
  if (me.seat || elapsed > 180_000) return endRace(false);
  timerEl.hidden = false;
  timerEl.textContent = `Lap ${(elapsed / 1000).toFixed(1)}s`;
  const gate = RACE[RACE_ORDER[race.step]];
  if (Math.hypot(gate.x - me.x, gate.z - me.z) > RACE_R) return;
  race.step++;
  if (race.step === RACE_ORDER.length) endRace(true);
  else games.setNextGate(RACE_ORDER[race.step]);
}

let lastKick = 0;
let lastShot = 0;
const inside = (c: Collider, x: number, z: number) =>
  Math.abs(x - c.x) < c.hw + BODY && Math.abs(z - c.z) < c.hd + BODY;
/** Would moving to (x, z) walk into something? Things you already overlap (the chair you just stood up from) don't count. */
const blocked = (x: number, z: number, fromX: number, fromZ: number) =>
  solid.some((c) => inside(c, x, z) && !inside(c, fromX, fromZ));

const turnToward = (from: number, to: number, k: number) => {
  const d = ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return from + d * k;
};

let askedToStand = false;
// My current velocity, in metres a second.
let velX = 0;
let velZ = 0;

function moveMe(dt: number) {
  if (!me) return;
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const moving = f !== 0 || r !== 0;

  if (duelUI.mine()) {
    // Feet planted while you fight.
    velX = velZ = 0;
    me.walking = false;
    return;
  }
  if (me.seat) {
    me.walking = false;
    // Trying to walk while seated stands you up.
    if (moving && !askedToStand) {
      askedToStand = true;
      send({ t: 'sit', seat: null });
    }
    return;
  }
  askedToStand = false;

  // Where the keys point. Forward is "away from the camera".
  let dx = 0;
  let dz = 0;
  if (moving) {
    dx = -Math.sin(camYaw) * f + Math.cos(camYaw) * r;
    dz = -Math.cos(camYaw) * f - Math.sin(camYaw) * r;
    const len = Math.hypot(dx, dz);
    dx /= len;
    dz /= len;
  }
  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const speed = moving ? (running ? RUN : WALK) : 0;
  // Ease towards that speed instead of jumping to it: a quick lean in, a slightly quicker stop.
  const ease = 1 - Math.exp(-(moving ? 13 : 17) * dt);
  velX += (dx * speed - velX) * ease;
  velZ += (dz * speed - velZ) * ease;
  const pace = Math.hypot(velX, velZ);
  if (pace < 0.08) {
    velX = velZ = 0;
    me.walking = false;
    return;
  }
  me.walking = true;
  const nx = Math.max(BOUNDS.x1 + EDGE, Math.min(BOUNDS.x2 - EDGE, me.x + velX * dt));
  const nz = Math.max(BOUNDS.z1 + EDGE, Math.min(BOUNDS.z2 - EDGE, me.z + velZ * dt));
  // Blocked one way, you slide along the other.
  if (!blocked(nx, me.z, me.x, me.z)) me.x = nx;
  else velX = 0;
  if (!blocked(me.x, nz, me.x, me.z)) me.z = nz;
  else velZ = 0;
  if (moving) me.ry = turnToward(me.ry, Math.atan2(dx, dz), Math.min(1, dt * 14));
  if (!moving) {
    dx = velX / pace;
    dz = velZ / pace;
  }

  // Football. Walking or running into the ball dribbles it: it takes on your movement and rolls a
  // little ahead of you. (Space shoots; see shoot().)
  const ball = games.ball;
  const bx = ball.x - me.x;
  const bz = ball.z - me.z;
  const gap = Math.hypot(bx, bz);
  const now = performance.now();
  if (gap < BODY + BALL_R + 0.08 && gap > 0.001 && ball.y < 1.1 && now - lastKick > 90) {
    const nx = bx / gap;
    const nz = bz / gap;
    const into = velX * nx + velZ * nz; // how fast I'm moving towards the ball
    if (into > 0.3) {
      lastKick = now;
      // Just a touch faster than you, so it rolls a step ahead and you catch it up.
      const push = Math.max(into, 1.8);
      const kx = velX * 0.55 + nx * push * 0.55;
      const kz = velZ * 0.55 + nz * push * 0.55;
      games.kick(kx, kz);
      send({ t: 'kick', vx: +kx.toFixed(2), vz: +kz.toFixed(2) });
    }
  }
}

/** Space: strike the ball if it is at your feet. Harder when you're running, and it lifts off the grass. */
function shoot() {
  if (!me || me.seat) return;
  const ball = games.ball;
  const bx = ball.x - me.x;
  const bz = ball.z - me.z;
  const gap = Math.hypot(bx, bz);
  const now = performance.now();
  if (gap > 2 || gap < 0.001 || ball.y > 1.2 || now - lastShot < 350) return;
  const faceX = Math.sin(me.ry);
  const faceZ = Math.cos(me.ry);
  // The ball has to be in front of you, not behind your heels.
  if ((bx / gap) * faceX + (bz / gap) * faceZ < 0.15) return;
  lastShot = now;
  lastKick = now + 250; // no dribble touch straight after, which would cancel the shot
  const pace = Math.hypot(velX, velZ);
  const power = Math.min(MAX_KICK, 12.5 + pace * 0.75);
  // Mostly where you're facing, bent a little by where the ball actually is.
  let kx = faceX * 0.75 + (bx / gap) * 0.25;
  let kz = faceZ * 0.75 + (bz / gap) * 0.25;
  const kl = Math.hypot(kx, kz) || 1;
  kx = (kx / kl) * power;
  kz = (kz / kl) * power;
  const lift = Math.min(MAX_LIFT, 5 + pace * 0.4);
  games.kick(kx, kz, lift);
  send({ t: 'kick', vx: +kx.toFixed(2), vz: +kz.toFixed(2), vy: +lift.toFixed(2) });
}

// Local development only: lets automated tests place the player. Removed from production builds.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__debug = {
    tp(x: number, z: number) {
      if (me) me.place(x, z, me.ry);
    },
    pos: () => (me ? [me.x, me.z] : null),
    ball: () => ({ ...games.ball }),
    id: () => myId,
    dropRoom: () => ws?.close(),
    duel: () => duelUI.mine(),
    talking: () => [...avatars].filter(([, a]) => a.speaking).map(([id]) => id),
    looks: () => Object.fromEntries([...avatars].map(([id, a]) => [id, a.info.look])),
    table: (id: string) => tableViews.get(id) ?? null,
    where: (id: string) => {
      const a = avatars.get(id);
      return a ? [a.x, a.z] : null;
    },
    solid: () => solid,
    showSolid: () => showColliders(world.scene, solid),
    cam: (yaw: number, pitch: number, dist: number) => {
      camYaw = wantYaw = yaw;
      camPitch = wantPitch = pitch;
      camDist = wantDist = dist;
    },
    media: () => media?.debug() ?? null,
    cams: () => Object.fromEntries([...cams].map(([id, el]) => [id, el.videoWidth])),
    drawn: () => ({ screen: world.screenFrames(), cams: Object.fromEntries([...avatars].map(([id, a]) => [id, a.videoFrames])) }),
    mirrored: () => Object.fromEntries([...avatars].map(([id, a]) => [id, a.mirrored])),
    camState: () => [...cams].map(([id, el]) => ({ id, paused: el.paused, t: el.currentTime, onPage: el.isConnected })),
    speaking: () => [...speaking],
  };
}

// ---------------------------------------------------------------- main loop

// Infinity (not NaN) so the very first comparison counts as "changed" and the position is sent.
const sent = { x: Infinity, z: Infinity, ry: Infinity };
let sendClock = 0;
let nearClock = 0;
let pingClock = 0;
let last = performance.now();
let lastFrameAt = last;

// Smoothness first: if this machine can't keep up, render fewer pixels (a slightly softer picture)
// rather than drop frames, and sharpen again when there is room to spare.
const MAX_SCALE = Math.min(devicePixelRatio, 2);
const MIN_SCALE = Math.min(0.7, MAX_SCALE);
let slowFor = 0;
let fastFor = 0;
let settleUntil = 0;
function setScale(next: number) {
  scale = next;
  renderer.setPixelRatio(scale);
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(scale);
  composer.setSize(innerWidth, innerHeight);
}
function adaptQuality(frameMs: number) {
  if (document.hidden || frameMs > 250 || performance.now() < settleUntil) return; // ignore tab switches and hitches
  slowFor = frameMs > 21 ? slowFor + frameMs : Math.max(0, slowFor - frameMs * 2);
  fastFor = frameMs < 17.5 ? fastFor + frameMs : 0;
  if (slowFor > 1200 && scale > MIN_SCALE) {
    setScale(Math.max(MIN_SCALE, scale - 0.25));
    slowFor = fastFor = 0;
    settleUntil = performance.now() + 1500;
  } else if (fastFor > 12_000 && scale < MAX_SCALE) {
    setScale(Math.min(MAX_SCALE, scale + 0.25));
    slowFor = fastFor = 0;
    settleUntil = performance.now() + 1500;
  }
}

function frame(nowMs: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const time = nowMs / 1000;

  const glide = 1 - Math.exp(-16 * dt);
  camYaw += (wantYaw - camYaw) * glide;
  camPitch += (wantPitch - camPitch) * glide;
  camDist += (wantDist - camDist) * glide;
  adaptQuality(nowMs - lastFrameAt);
  lastFrameAt = nowMs;

  moveMe(dt);
  tickRace();
  for (const a of avatars.values()) a.update(dt, camera);
  duelUI.frame();

  if (me) {
    camFocus.lerp(new THREE.Vector3(me.x, 1.6, me.z), 1 - Math.exp(-12 * dt));

    // Tell the server where I am, but only when it changed.
    sendClock += dt;
    if (sendClock >= 1 / TICK_HZ) {
      sendClock = 0;
      if (!me.seat && (Math.abs(me.x - sent.x) > 0.01 || Math.abs(me.z - sent.z) > 0.01 || Math.abs(me.ry - sent.ry) > 0.05)) {
        sent.x = me.x;
        sent.z = me.z;
        sent.ry = me.ry;
        send({ t: 'move', x: +me.x.toFixed(2), z: +me.z.toFixed(2), ry: +me.ry.toFixed(2) });
      }
    }

    pingClock += dt;
    if (pingClock > 20) {
      pingClock = 0;
      send({ t: 'ping' });
    }

    // Who can I hear and see? Recomputed a few times a second.
    nearClock += dt;
    if (nearClock > 0.25) {
      nearClock = 0;
      if (media) {
        const group = myGridGroup();
        const near = new Map<string, Near>();
        for (const [id, a] of avatars) {
          if (id === myId) continue;
          near.set(id, { dist: Math.hypot(a.x - me.x, a.z - me.z), together: !!group && seatGroup(a.seat) === group });
        }
        const toScreen = Math.hypot(me.x - SCREEN.x, me.z - SCREEN.z);
        // Full volume in and around the cinema, fading with distance but never silent: at the far end of
        // the roof a film is still faintly audible, so nobody thinks the sound is broken.
        media.screenVolume = theaterEl.hidden ? Math.max(0.15, Math.min(1, 1 - (toScreen - 16) / 30)) : 1;
        media.updateProximity(near);
      }
      // The recipe list only shows while you are standing in the kitchen.
      menuEl.hidden = me.x < 10 || me.z < -6 || me.z > 12 || !!me.seat;

      const t = me.seat ? null : nearest();
      const rival = !t && !me.seat ? duelTarget() : null;
      const text = me.seat ? (myGridGroup() ? '' : 'E — stand up') : t ? promptFor(t) : rival ? `G — challenge ${rival.info.name} to a duel` : '';
      promptEl.textContent = text;
      promptEl.hidden = !text || !theaterEl.hidden;
    }
  }

  // Keep a low camera inside the parapet so the wall never fills the view; a high camera may drift out past the edge.
  const cp = Math.cos(camPitch);
  const dirX = Math.sin(camYaw) * cp;
  const dirY = Math.sin(camPitch);
  const dirZ = Math.cos(camYaw) * cp;
  let fit = camDist;
  for (let i = 0; i < 14; i++) {
    const slack = Math.max(0, camFocus.y + dirY * fit - 2) * 4 - 0.5;
    const cx = camFocus.x + dirX * fit;
    const cz = camFocus.z + dirZ * fit;
    if (cx >= BOUNDS.x1 - slack && cx <= BOUNDS.x2 + slack && cz >= BOUNDS.z1 - slack && cz <= BOUNDS.z2 + slack) break;
    fit *= 0.88;
  }
  shownDist += (fit - shownDist) * Math.min(1, dt * 10);
  camera.position.set(camFocus.x + dirX * shownDist, camFocus.y + dirY * shownDist, camFocus.z + dirZ * shownDist);
  camera.lookAt(camFocus);

  kitchen.update(camera);
  games.update(time, dt);
  world.update(time, dt);
  composer.render();
  fpsCount++;
}
requestAnimationFrame(frame);
