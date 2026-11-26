import type { Feature, FeatureCtx } from './api';
import './touch.css';

// Phone and tablet controls: a joystick that holds the walking keys, buttons that press the action
// keys, and finger dragging on the picture to look around. Nothing is built until the device turns
// out to have a touch screen, so a mouse-and-keyboard player never sees any of it.

const STEER = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'];
/** The keys for each eighth of the circle, anticlockwise from "right". */
const DIRS = [['KeyD'], ['KeyW', 'KeyD'], ['KeyW'], ['KeyW', 'KeyA'], ['KeyA'], ['KeyS', 'KeyA'], ['KeyS'], ['KeyS', 'KeyD']];
const DEAD = 0.22; // of the radius: a resting thumb does not walk
const RUN = 0.85; // of the radius: pushed this far, run
const EMOJI = ['👋', '😂', '❤️', '🔥', '👏', '💀'];

let ctx: FeatureCtx;
let on = false;
let useBtn: HTMLButtonElement;
let chopBtn: HTMLButtonElement;
let useCode = 'KeyE';
let shownPrompt: string | null = null;
let shownSeated = false;
let clock = 0;
let grid: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, text: string, label = text) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  return b;
}

/**
 * An action button that fires the moment a finger lands. A tap made while another finger is on the
 * joystick never becomes a click on phones, so waiting for click would mean no shooting on the run.
 * Click still works for anything that is not a pointer (a keyboard, a test).
 */
function instant(b: HTMLElement, fn: () => void) {
  let last = -1e9;
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    last = performance.now();
    fn();
  });
  b.addEventListener('click', () => {
    if (performance.now() - last > 800) fn();
  });
}

// ---------------------------------------------------------------- joystick

/** The steering keys the joystick is holding, so letting go releases those and no others. */
const mine = new Set<string>();
function steer(want: string[]) {
  for (const code of STEER) {
    if (want.includes(code)) {
      if (!ctx.keys.has(code)) {
        ctx.keys.add(code);
        mine.add(code);
      }
    } else if (mine.delete(code)) ctx.keys.delete(code);
  }
}

function buildStick() {
  const base = el('div', 'ft-touch-stick');
  const knob = el('div', 'ft-touch-knob');
  base.append(knob);
  let finger: number | null = null;

  const move = (e: PointerEvent) => {
    const r = base.getBoundingClientRect();
    const radius = r.width / 2 || 1;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + r.height / 2)) / radius;
    const push = Math.hypot(dx, dy);
    if (push > 1) {
      dx /= push;
      dy /= push;
    }
    knob.style.transform = `translate(${dx * radius * 0.62}px, ${dy * radius * 0.62}px)`;
    if (push < DEAD) return steer([]);
    const eighth = ((Math.round(Math.atan2(-dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
    base.classList.toggle('ft-touch-run', push >= RUN);
    steer(push >= RUN ? [...DIRS[eighth], 'ShiftLeft'] : DIRS[eighth]);
  };
  const release = () => {
    finger = null;
    knob.style.transform = '';
    base.classList.remove('ft-touch-run', 'ft-touch-held');
    steer([]);
  };

  base.addEventListener('pointerdown', (e) => {
    if (finger !== null) return;
    finger = e.pointerId;
    base.classList.add('ft-touch-held');
    try {
      base.setPointerCapture(e.pointerId);
    } catch {
      // Not a live pointer (a test's made-up event): its moves are sent straight to the joystick anyway.
    }
    e.preventDefault();
    move(e);
  });
  base.addEventListener('pointermove', (e) => {
    if (e.pointerId === finger) move(e);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    base.addEventListener(type, (e) => {
      if (e.pointerId === finger) release();
    });
  }
  // The room drops every held key when the window loses focus; drop the thumb with them.
  addEventListener('blur', release);
  return base;
}

// ---------------------------------------------------------------- camera

/**
 * A clear sheet over the picture that takes the drags. It sits under every other control, so it only
 * gets fingers that land on the 3D view. The room's own handler on the canvas relies on movementX,
 * which phones report as 0 (or, on some, as a real number, which would turn the view twice).
 */
function buildLook(closePopup: () => void) {
  const sheet = el('div', 'ft-touch-look');
  const fingers = new Map<number, { x: number; y: number }>();
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  sheet.addEventListener('pointerdown', (e) => {
    closePopup();
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      sheet.setPointerCapture(e.pointerId);
    } catch {
      // As for the joystick.
    }
  });
  sheet.addEventListener('pointermove', (e) => {
    const f = fingers.get(e.pointerId);
    if (!f) return;
    if (fingers.size === 1) {
      // The same speeds as dragging with a mouse.
      ctx.look(-(e.clientX - f.x) * 0.005, (e.clientY - f.y) * 0.004, 0);
      f.x = e.clientX;
      f.y = e.clientY;
      return;
    }
    const before = spread();
    f.x = e.clientX;
    f.y = e.clientY;
    // Fingers moving apart bring the camera closer.
    ctx.look(0, 0, (before - spread()) * 0.04);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) sheet.addEventListener(type, (e) => fingers.delete(e.pointerId));
  // The sheet covers the canvas, so a trackpad or mouse wheel on a touch laptop has to zoom from here.
  sheet.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      ctx.look(0, 0, e.deltaY * 0.012);
    },
    { passive: false },
  );
  return sheet;
}

// ---------------------------------------------------------------- buttons

function buildPad() {
  const pad = el('div', 'ft-touch-pad');

  const emotes = el('div', 'ft-touch-emotes');
  emotes.hidden = true;
  const closePopup = () => {
    emotes.hidden = true;
  };
  EMOJI.forEach((emoji, i) => {
    const b = button('ft-touch-emote', emoji);
    b.onclick = () => {
      ctx.press(`Digit${i + 1}`);
      closePopup();
    };
    emotes.append(b);
  });
  const dance = button('ft-touch-emote', '💃', 'Dance');
  dance.onclick = () => {
    ctx.press('Digit7');
    closePopup();
  };
  emotes.append(dance);

  // These three wait for a click: a phone only opens its keyboard for the chat box from a finished tap.
  const row = el('div', 'ft-touch-row');
  const chat = button('ft-touch-small', '💬', 'Chat');
  chat.onclick = () => {
    closePopup();
    ctx.press('Enter');
  };
  const react = button('ft-touch-small', '😀', 'Reactions');
  react.onclick = () => {
    emotes.hidden = !emotes.hidden;
  };
  const guide = button('ft-touch-small', '?', 'Guide');
  guide.onclick = () => {
    closePopup();
    ctx.press('KeyH');
  };
  row.append(chat, react, guide);

  const main = el('div', 'ft-touch-main');
  const side = el('div', 'ft-touch-side');
  chopBtn = button('ft-touch-chop', 'Chop');
  chopBtn.hidden = true;
  instant(chopBtn, () => ctx.press('KeyF'));
  const kick = button('ft-touch-kick', 'Kick');
  instant(kick, () => ctx.press('Space'));
  side.append(chopBtn, kick);
  useBtn = button('ft-touch-use', 'Use');
  instant(useBtn, () => ctx.press(useCode));
  main.append(side, useBtn);

  pad.append(emotes, row, main);
  return { pad, closePopup };
}

/** Make the Use button say what it will do, from the room's prompt ('E — sit down', 'G — challenge Bao to a duel'). */
function showPrompt() {
  const prompt = ctx.prompt();
  // Sat at a game table the prompt is empty and the table covers the screen, yet E is the way out.
  const seated = !!grid && !grid.hidden;
  if (prompt === shownPrompt && seated === shownSeated) return;
  shownPrompt = prompt;
  shownSeated = seated;
  const parts = prompt.split(' · ');
  const use = parts.map((p) => /^([EG]) — (.+)$/.exec(p)).find((m) => m);
  useCode = use?.[1] === 'G' ? 'KeyG' : 'KeyE';
  const label = use ? use[2][0].toUpperCase() + use[2].slice(1) : seated ? 'Stand up' : 'Use';
  useBtn.textContent = label;
  useBtn.setAttribute('aria-label', label);
  // Dimmed, not disabled: E still does something with no prompt showing (standing up from some seats).
  useBtn.classList.toggle('ft-touch-dim', !use && !seated);
  chopBtn.hidden = !parts.some((p) => p.startsWith('F — '));
  document.body.classList.toggle('ft-touch-seated', seated);
}

function enable() {
  if (on) return;
  on = true;
  grid = document.getElementById('grid');
  const { pad, closePopup } = buildPad();
  const stick = buildStick();
  // First in the HUD, so everything else in it is drawn (and touched) above the look sheet.
  ctx.hud.prepend(buildLook(closePopup));
  ctx.hud.append(stick, pad);
  // No long-press menus or text selection handles over the controls.
  for (const e of [stick, pad]) e.addEventListener('contextmenu', (ev) => ev.preventDefault());
  document.body.classList.add('ft-touch-on');

  // On a narrow screen the chat box moves from the bottom, where the controls now are, to just under
  // the top bar, however many rows that has wrapped to.
  const place = () => document.body.style.setProperty('--ft-touch-top', `${Math.round(ctx.topbar.getBoundingClientRect().bottom + 8)}px`);
  try {
    new ResizeObserver(place).observe(ctx.topbar);
  } catch {
    addEventListener('resize', place);
  }
  place();
  showPrompt();
}

export const feature: Feature = {
  init(c) {
    ctx = c;
    let coarse = false;
    try {
      coarse = matchMedia('(pointer: coarse)').matches;
    } catch {
      // Very old browser: wait for a touch instead.
    }
    if (coarse) enable();
    // A laptop with a touch screen: the controls appear the first time it is touched.
    else addEventListener('touchstart', enable, { once: true, passive: true, capture: true });
  },
  frame(dt) {
    if (!on) return;
    // The prompt itself only changes a few times a second.
    clock += dt;
    if (clock < 0.1) return;
    clock = 0;
    showPrompt();
  },
};
