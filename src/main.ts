import * as THREE from 'three';
import './style.css';
import { COLORS, ROOM_HALF, TICK_HZ, type ClientMsg, type PlayerInfo, type ServerMsg } from '../shared/protocol';
import { COLLIDERS, GRID_GROUPS, SCREEN, SEATS, STATIONS, seatGroup, type Seat, type Station } from '../shared/layout';
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
const world = buildWorld();
const kitchen = new KitchenView(world.scene);

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
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
let camPitch = 0.5;
let camDist = 12;
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

const gridVideos: HTMLVideoElement[] = [];
const gridTileById = new Map<string, HTMLElement>();

function renderGrid() {
  for (const el of gridVideos) media?.release(el);
  gridVideos.length = 0;
  gridTileById.clear();
  gridTiles.replaceChildren();

  const group = myGridGroup();
  gridEl.hidden = !group;
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
wireToggle(btnMic, 'Mic on', 'Mic off', () => media!.toggleMic());
wireToggle(btnCam, 'Camera on', 'Camera off', () => media!.toggleCamera());
btnShare.onclick = async () => {
  try {
    await media!.toggleScreen();
  } catch (err) {
    console.error(err); // usually just the person cancelling the picker
  }
  refreshMediaButtons();
};
for (const b of [btnMic, btnCam, btnShare]) b.hidden = true;

// ---------------------------------------------------------------- network

function handle(msg: ServerMsg) {
  switch (msg.t) {
    case 'welcome': {
      myId = msg.id;
      for (const p of msg.players) addAvatar(p);
      me = avatars.get(myId)!;
      me.local = true;
      camFocus.set(me.x, 1.6, me.z);
      kitchen.setState(msg.kitchen, avatars);
      renderMenu();
      $('join').hidden = true;
      $('hud').hidden = false;
      logLine('You came in. Press Enter to chat.');
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
  if (t.seat) return 'E — sit down';
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
  else if (t?.station) send({ t: 'use', station: t.station.id });
}

addEventListener('keydown', (e) => {
  if (!me || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return;
  switch (e.code) {
    case 'Enter':
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
    case 'Escape':
      closeTheater();
      return;
  }
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

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

const LIMIT = ROOM_HALF - 0.7;
const BODY = 0.38;
const blocked = (x: number, z: number) =>
  COLLIDERS.some((c) => Math.abs(x - c.x) < c.hw + BODY && Math.abs(z - c.z) < c.hd + BODY);

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
  const step = 5.5 * dt;
  const nx = Math.max(-LIMIT, Math.min(LIMIT, me.x + dx * step));
  const nz = Math.max(-LIMIT, Math.min(LIMIT, me.z + dz * step));
  if (!blocked(nx, me.z)) me.x = nx;
  if (!blocked(me.x, nz)) me.z = nz;
  me.ry = turnToward(me.ry, Math.atan2(dx, dz), Math.min(1, dt * 14));
}

// ---------------------------------------------------------------- main loop

const sent = { x: NaN, z: NaN, ry: NaN };
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
        media.screenVolume = theaterEl.hidden ? Math.max(0, Math.min(1, 1 - (toScreen - 13) / 12)) : 1;
        media.updateProximity(near);
      }
      menuEl.hidden = me.x < 10 || !!me.seat;

      const t = me.seat ? null : nearest();
      const text = me.seat ? (myGridGroup() ? '' : 'E — stand up') : t ? promptFor(t) : '';
      promptEl.textContent = text;
      promptEl.hidden = !text || !theaterEl.hidden;
    }
  }

  const cp = Math.cos(camPitch);
  camera.position.set(
    camFocus.x + Math.sin(camYaw) * cp * camDist,
    camFocus.y + Math.sin(camPitch) * camDist,
    camFocus.z + Math.cos(camYaw) * cp * camDist,
  );
  camera.lookAt(camFocus);

  kitchen.update(camera);
  world.update(time);
  renderer.render(world.scene, camera);
}
requestAnimationFrame(frame);
