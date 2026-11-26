import './sound.css';
import type { Feature, FeatureCtx, ClientEvent } from './api';
import { LOUNGE } from '../../shared/layout';
import { MAX_KICK } from '../../shared/ball';
import { workWord } from '../../shared/fun';

// Quiet ambient sound, all made on the spot with Web Audio: footsteps, the fire, the ball, people
// coming and going, chat, and a little wind. It sits under people's voices, so every level is low.
// The louder one-off effects (goals, reactions, duels, the work-talk alarm) belong to src/fun.ts.

// ---------------------------------------------------------------- pure helpers (unit-tested)

export type Mode = 'on' | 'quiet' | 'off';
export const MODES: Mode[] = ['on', 'quiet', 'off'];
export const MASTER: Record<Mode, number> = { on: 0.55, quiet: 0.22, off: 0 };

export const STEP_RANGE = 14;
export const FIRE_RANGE = 16;
export const KICK_RANGE = 34;
/** At most this many footsteps sound at once, however crowded the room is. */
export const STEP_VOICES = 6;

/** How loud something `dist` metres away is, 0..1: full at no distance, silent from `range` outwards. */
export function falloff(dist: number, range: number): number {
  if (!(range > 0) || !(dist < range)) return 0; // also catches NaN
  if (dist <= 0) return 1;
  const t = 1 - dist / range;
  return t * t; // drops quickly at first, then tails off, roughly as real sound does
}

/** Seconds between footfalls at this speed (metres a second): a stroll is slow, a sprint quick. */
export function stepInterval(speed: number): number {
  const s = Number.isFinite(speed) ? speed : 0;
  const t = Math.min(1, Math.max(0, (s - 2) / 6));
  return 0.44 - t * 0.2;
}

/** How hard a kick sounds, 0..1, from the ball's speed off the boot. Even a tap is audible. */
export function kickLevel(power: number): number {
  const p = Number.isFinite(power) ? power : 0;
  return 0.3 + 0.7 * Math.min(1, Math.max(0, p / MAX_KICK));
}

export function nextMode(mode: Mode): Mode {
  return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
}

export function parseMode(saved: string | null): Mode {
  return saved === 'quiet' || saved === 'off' ? saved : 'on';
}

// ---------------------------------------------------------------- levels (before the master volume)

const OWN_STEP = 0.1;
const OTHER_STEP = 0.16;
const FIRE_BED = 0.1;
const FIRE_POP = 0.22;
const WIND = 0.05;
const KICK = 0.4;
const CHIME = 0.07;

// ---------------------------------------------------------------- the audio graph, built once

/** A filter and a gain fed by the one shared noise loop: silent until its gain is opened. */
interface Voice {
  filter: BiquadFilterNode;
  gain: GainNode;
  busyUntil: number;
}

interface Graph {
  ac: AudioContext;
  master: GainNode;
  steps: Voice[];
  fire: GainNode; // the whole fire, turned up and down with distance
  pop: Voice;
  wind: GainNode;
  thud: Voice;
}

/** Where a walker was last frame, to work out how fast they are going. */
interface Walker {
  x: number;
  z: number;
  speed: number;
  wait: number;
  seen: number;
  left: boolean;
}

let room: FeatureCtx | null = null;
let graph: Graph | null = null;
let broken = false; // audio could not be made: stop trying
let allowed = false; // the browser has seen a click or key press
let mode: Mode = 'on';
let button: HTMLButtonElement | null = null;

const walkers = new Map<string, Walker>();
let frameNo = 0;
let ambientIn = 0;
let popIn = 0;
let fireNear = 0;
let lastKick = -1;
let lastBlip = -1;

function voice(ac: AudioContext, noise: AudioNode, out: AudioNode, type: BiquadFilterType, freq: number, q: number): Voice {
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.value = 0;
  noise.connect(filter).connect(gain).connect(out);
  return { filter, gain, busyUntil: 0 };
}

function build(): Graph {
  const ac = new AudioContext();
  const master = ac.createGain();
  master.gain.value = MASTER[mode];
  master.connect(ac.destination);

  // One loop of noise feeds everything: nothing is allocated for a footstep or a crackle.
  const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 3), ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const noise = ac.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;
  noise.start();

  const steps: Voice[] = [];
  for (let i = 0; i < STEP_VOICES; i++) steps.push(voice(ac, noise, master, 'lowpass', 700, 0.8));

  // Fire: a low steady rush, with sharp little pops over the top.
  const fire = ac.createGain();
  fire.gain.value = 0;
  fire.connect(master);
  const bed = voice(ac, noise, fire, 'bandpass', 420, 0.6);
  bed.gain.gain.value = FIRE_BED;
  const pop = voice(ac, noise, fire, 'bandpass', 2400, 2.5);

  // Wind: deep noise whose tone drifts slowly, so it never sounds like a steady hiss.
  const wind = ac.createGain();
  wind.gain.value = 0;
  wind.connect(master);
  const air = voice(ac, noise, wind, 'lowpass', 320, 0.4);
  air.gain.gain.value = 1;
  const drift = ac.createOscillator();
  drift.frequency.value = 0.07;
  const depth = ac.createGain();
  depth.gain.value = 140;
  drift.connect(depth).connect(air.filter.frequency);
  drift.start();

  const thud = voice(ac, noise, master, 'lowpass', 380, 0.7);
  return { ac, master, steps, fire, pop, wind, thud };
}

/** Make the sound system if it is wanted and allowed, and run or pause it to match the page. */
function sync() {
  if (broken) return;
  try {
    const wanted = mode !== 'off' && !document.hidden;
    if (!graph) {
      if (!wanted || !allowed) return;
      graph = build();
    }
    const { ac, master } = graph;
    master.gain.setTargetAtTime(MASTER[mode], ac.currentTime, 0.05);
    if (wanted) {
      if (ac.state !== 'running') void ac.resume().catch(() => {});
    } else if (ac.state === 'running') {
      void ac.suspend().catch(() => {});
    }
  } catch {
    broken = true;
    graph = null;
  }
}

/** The graph, if sound is actually coming out right now. */
function live(): Graph | null {
  return graph && mode !== 'off' && graph.ac.state === 'running' ? graph : null;
}

/** A short burst of the voice's noise: straight up, then dying away over `decay` seconds. */
function burst(g: Graph, v: Voice, level: number, decay: number, freq?: number) {
  const t = g.ac.currentTime;
  if (freq) v.filter.frequency.setValueAtTime(freq, t);
  const p = v.gain.gain;
  p.cancelScheduledValues(t);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(level, t + 0.005);
  p.setTargetAtTime(0, t + 0.005, decay / 3);
  v.busyUntil = t + decay + 0.02;
}

/** A soft note. These are rare (someone arrives, a chat line), so each makes its own oscillator. */
function note(g: Graph, freq: number, start: number, length: number, level: number, slideTo?: number, type: OscillatorType = 'sine') {
  const t = g.ac.currentTime + start;
  const osc = g.ac.createOscillator();
  const gain = g.ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(level, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(g.master);
  osc.onended = () => gain.disconnect();
  osc.start(t);
  osc.stop(t + length + 0.05);
}

function footstep(g: Graph, w: Walker, level: number) {
  const now = g.ac.currentTime;
  const v = g.steps.find((s) => s.busyUntil <= now);
  if (!v) return; // every voice is busy: one missed step in a crowd is not noticed
  w.left = !w.left;
  // Left and right feet differ a little, and no two steps are quite alike.
  burst(g, v, level * (0.8 + Math.random() * 0.2), 0.09, (w.left ? 560 : 680) + Math.random() * 160);
}

function footsteps(g: Graph, dt: number, mx: number, mz: number) {
  const c = room!;
  const mine = c.myId();
  for (const [id, a] of c.avatars) {
    if (!a.walking) continue;
    const dx = a.x - mx;
    const dz = a.z - mz;
    if (dx * dx + dz * dz >= STEP_RANGE * STEP_RANGE) continue;
    let w = walkers.get(id);
    if (!w) walkers.set(id, (w = { x: a.x, z: a.z, speed: 4, wait: 0, seen: -1, left: false }));
    if (w.seen === frameNo - 1) {
      // The avatar does not expose its pace, so measure it from how far it moved.
      const moved = Math.hypot(a.x - w.x, a.z - w.z) / dt;
      if (moved < 30) w.speed += (moved - w.speed) * Math.min(1, dt * 6); // a jump that big is a teleport
      w.wait -= dt;
    } else {
      // Just set off (or just came into earshot): first footfall shortly, at a walking pace.
      w.speed = 4;
      w.wait = 0.12;
    }
    w.x = a.x;
    w.z = a.z;
    w.seen = frameNo;
    if (w.wait > 0) continue;
    w.wait = stepInterval(w.speed);
    const own = id === mine || a.local;
    footstep(g, w, (own ? OWN_STEP : OTHER_STEP) * falloff(Math.hypot(dx, dz), STEP_RANGE));
  }
}

function onEvent(e: ClientEvent) {
  if (e.kind === 'leave') walkers.delete(e.id);
  if (e.kind === 'welcome') walkers.clear(); // a fresh room: everyone has a new id
  const g = live();
  const c = room;
  if (!g || !c) return;
  const now = g.ac.currentTime;
  if (e.kind === 'kick') {
    // My own kick can be reported twice: once as I strike, once when the server's ball arrives.
    if (now - lastKick < 0.15) return;
    const me = c.me();
    const ball = c.ball();
    if (!me) return;
    const level = KICK * kickLevel(e.power) * falloff(Math.hypot(ball.x - me.x, ball.z - me.z), KICK_RANGE);
    if (level < 0.004) return;
    lastKick = now;
    note(g, 150, 0, 0.16, level, 48);
    burst(g, g.thud, level * 0.6, 0.07);
  } else if (e.kind === 'join') {
    note(g, 659, 0, 0.5, CHIME);
    note(g, 880, 0.13, 0.6, CHIME);
  } else if (e.kind === 'leave') {
    note(g, 587, 0, 0.45, CHIME * 0.6);
    note(g, 440, 0.14, 0.6, CHIME * 0.6);
  } else if (e.kind === 'chat') {
    // Not for my own lines, not in a flurry, and not on top of the work-talk alarm.
    if (e.id === c.myId() || now - lastBlip < 0.3 || workWord(e.text)) return;
    lastBlip = now;
    note(g, 740, 0, 0.1, CHIME * 0.7, 930);
  }
}

// ---------------------------------------------------------------- the button

const ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="ft-sound-body" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/>' +
  '<path class="ft-sound-w1" d="M15 9.5a3.6 3.6 0 0 1 0 5"/><path class="ft-sound-w2" d="M17.6 7a7.2 7.2 0 0 1 0 10"/>' +
  '<path class="ft-sound-x" d="M15.5 9.5l5 5m0-5l-5 5"/></svg>';
const LABEL: Record<Mode, string> = { on: 'Sound on', quiet: 'Sound quiet', off: 'Sound off' };

function showMode() {
  if (!button) return;
  button.dataset.mode = mode;
  button.title = `${LABEL[mode]} (click to change)`;
  button.setAttribute('aria-label', LABEL[mode]);
}

export const feature: Feature = {
  init(ctx) {
    room = ctx;
    try {
      mode = parseMode(ctx.store.get('sound'));
    } catch {
      mode = 'on';
    }

    button = document.createElement('button');
    button.type = 'button';
    button.className = 'ft-sound';
    button.innerHTML = ICON;
    button.addEventListener('click', () => {
      mode = nextMode(mode);
      try {
        ctx.store.set('sound', mode);
      } catch {
        // Not remembered, then.
      }
      showMode();
      allowed = true; // a click counts as the browser's permission
      sync();
      ctx.toast(LABEL[mode]);
    });
    showMode();
    ctx.topbar.append(button);

    // Browsers only let sound start after a click or a key press, so wait for one.
    const unlock = () => {
      allowed = true;
      sync();
      if (broken || graph?.ac.state === 'running') {
        removeEventListener('pointerdown', unlock, true);
        removeEventListener('keydown', unlock, true);
      }
    };
    addEventListener('pointerdown', unlock, true);
    addEventListener('keydown', unlock, true);
    document.addEventListener('visibilitychange', sync);
    ctx.on(onEvent);
  },

  frame(dt) {
    frameNo++;
    const g = live();
    const me = room?.me();
    if (!g || !room) return;
    try {
      // The fire and the wind change slowly: a few times a second is plenty.
      ambientIn -= dt;
      if (ambientIn <= 0) {
        ambientIn = 0.15;
        fireNear = me ? falloff(Math.hypot(me.x - LOUNGE.x, me.z - LOUNGE.z), FIRE_RANGE) : 0;
        const t = g.ac.currentTime;
        g.fire.gain.setTargetAtTime(fireNear, t, 0.25);
        g.wind.gain.setTargetAtTime(me ? WIND : 0, t, 0.8);
      }
      if (!me || dt <= 0) return;
      if (fireNear > 0) {
        popIn -= dt;
        if (popIn <= 0) {
          popIn = 0.04 + Math.random() * Math.random() * 0.7; // mostly quick, now and then a lull
          burst(g, g.pop, FIRE_POP * (0.25 + Math.random() * 0.75), 0.012 + Math.random() * 0.03, 1500 + Math.random() * 2600);
        }
      }
      footsteps(g, dt, me.x, me.z);
    } catch {
      // A hiccup in the audio must never stop the room drawing.
    }
  },
};
