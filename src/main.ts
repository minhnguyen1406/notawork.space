import * as THREE from 'three';
import { sceneColliders, showColliders } from './collide';
import { confetti, flash, play } from './fun';
import { EMOJI } from '../shared/fun';
import type { Collider } from '../shared/layout';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import './style.css';
import { COLORS, TICK_HZ, type ClientMsg, type PlayerInfo, type ServerMsg } from '../shared/protocol';
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
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.7, 1.0));
composer.addPass(new OutputPass());

function resize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
let camYaw = 0;
let camPitch = 0.42;
let camDist = 12;
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

async function startMedia(url: string, token: string) {
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
      renderMenu();
      $('join').hidden = true;
      $('hud').hidden = false;
      logLine('You came in. Press Enter to chat, H for the guide.');
      if (msg.media) void startMedia(msg.media.url, msg.media.token);
      else logLine('Voice and video are not set up on this server yet.');
      break;
    }
    case 'denied':
      joinFailed(msg.reason === 'password' ? 'That password is not right.' : 'The room is full right now.');
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
  joinError.hidden = true;
  joinButton.disabled = true;

  const socket = new WebSocket(wsUrl);
  ws = socket;
  socket.onopen = () => send({ t: 'join', name, color, password: passwordInput.value || undefined });
  socket.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string));
    } catch (err) {
      console.error('bad message', err);
    }
  };
  socket.onclose = () => {
    if (me) toast('Connection lost. Reload the page to come back in.', true);
    else if (joinError.hidden) joinFailed('Could not reach the room. Try again in a moment.');
  };
};

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
    case 'Digit1':
    case 'Digit2':
    case 'Digit3':
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
    `3D picture: ${Math.round(fps)} fps`,
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
  camYaw -= e.movementX * 0.005;
  camPitch = Math.max(0.12, Math.min(1.35, camPitch + e.movementY * 0.004));
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    camDist = Math.max(4, Math.min(26, camDist + e.deltaY * 0.012));
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

function moveMe(dt: number) {
  if (!me) return;
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const moving = f !== 0 || r !== 0;

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
  me.walking = moving;
  if (!moving) return;

  // Forward is "away from the camera".
  let dx = -Math.sin(camYaw) * f + Math.cos(camYaw) * r;
  let dz = -Math.cos(camYaw) * f - Math.sin(camYaw) * r;
  const len = Math.hypot(dx, dz);
  dx /= len;
  dz /= len;
  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const step = (running ? RUN : WALK) * dt;
  const nx = Math.max(BOUNDS.x1 + EDGE, Math.min(BOUNDS.x2 - EDGE, me.x + dx * step));
  const nz = Math.max(BOUNDS.z1 + EDGE, Math.min(BOUNDS.z2 - EDGE, me.z + dz * step));
  if (!blocked(nx, me.z, me.x, me.z)) me.x = nx;
  if (!blocked(me.x, nz, me.x, me.z)) me.z = nz;
  me.ry = turnToward(me.ry, Math.atan2(dx, dz), Math.min(1, dt * 14));

  // Football: walking into the ball kicks it, mostly away from you and a little the way you're heading.
  const ball = games.ball;
  const bx = ball.x - me.x;
  const bz = ball.z - me.z;
  const gap = Math.hypot(bx, bz);
  const now = performance.now();
  if (gap < BODY + BALL_R + 0.15 && gap > 0.001 && now - lastKick > 180) {
    lastKick = now;
    let kx = (bx / gap) * 0.65 + dx * 0.35;
    let kz = (bz / gap) * 0.65 + dz * 0.35;
    const kl = Math.hypot(kx, kz) || 1;
    const power = running ? 14 : 9;
    kx = (kx / kl) * power;
    kz = (kz / kl) * power;
    games.kick(kx, kz);
    send({ t: 'kick', vx: +kx.toFixed(2), vz: +kz.toFixed(2) });
  }
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
    solid: () => solid,
    showSolid: () => showColliders(world.scene, solid),
    cam: (yaw: number, pitch: number, dist: number) => {
      camYaw = yaw;
      camPitch = pitch;
      camDist = dist;
    },
    media: () => media?.debug() ?? null,
    cams: () => Object.fromEntries([...cams].map(([id, el]) => [id, el.videoWidth])),
    drawn: () => ({ screen: world.screenFrames(), cams: Object.fromEntries([...avatars].map(([id, a]) => [id, a.videoFrames])) }),
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

function frame(nowMs: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const time = nowMs / 1000;

  moveMe(dt);
  tickRace();
  for (const a of avatars.values()) a.update(dt, camera);

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
      const text = me.seat ? (myGridGroup() ? '' : 'E — stand up') : t ? promptFor(t) : '';
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
