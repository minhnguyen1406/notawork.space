import type { Feature, FeatureCtx } from './api';
import './photo.css';

// Photo mode: P hides the interface and leaves the 3D view with a small bar of its own.

const COUNTDOWN = 3;
const PREVIEW_MS = 6000;
// The saved file and the thumbnail share one address. It is let go well after the preview has gone,
// because some browsers start the download a moment after the click.
const URL_LIFE_MS = 20000;

let ctx: FeatureCtx;
let active = false;
let busy = false; // a capture is in progress
let timerOn = false;
let countdownTimer = 0;
let previewTimer = 0;
let lastBlob: Blob | null = null;

let root: HTMLElement;
let bar: HTMLElement;
let shootBtn: HTMLButtonElement;
let timerBtn: HTMLButtonElement;
let countEl: HTMLElement;
let flashEl: HTMLElement;
let statusEl: HTMLElement;
let preview: HTMLElement;
let previewImg: HTMLImageElement;
let copyBtn: HTMLButtonElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', () => {
    // Do not keep the focus: a focused button is pressed again by the next Space or Enter.
    b.blur();
    onClick();
  });
  return b;
}

function fileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `notawork-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

function canCopy(): boolean {
  try {
    return typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  } catch {
    return false;
  }
}

function say(text: string) {
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = 0;
  countEl.hidden = true;
  shootBtn.textContent = 'Take photo';
}

function hidePreview() {
  clearTimeout(previewTimer);
  preview.hidden = true;
  previewImg.removeAttribute('src');
  lastBlob = null;
}

function showPreview(url: string, blob: Blob) {
  clearTimeout(previewTimer);
  lastBlob = blob;
  previewImg.src = url;
  copyBtn.textContent = 'Copy';
  copyBtn.hidden = !canCopy();
  preview.hidden = false;
  previewTimer = window.setTimeout(hidePreview, PREVIEW_MS);
}

async function copy() {
  const blob = lastBlob;
  if (!blob) return;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    copyBtn.textContent = 'Copied';
  } catch {
    copyBtn.textContent = 'Could not copy';
  }
  // Leave the result on screen long enough to read.
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(hidePreview, 2500);
}

function flash() {
  // Restart the animation even if the last flash has not finished.
  flashEl.classList.remove('ft-photo-flash-on');
  void flashEl.offsetWidth;
  flashEl.classList.add('ft-photo-flash-on');
}

function save(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName();
  a.className = 'ft-photo-link';
  document.body.append(a);
  a.click();
  a.remove();
}

async function shoot() {
  if (!active || busy) return;
  busy = true;
  say('');
  // Nothing of ours should be on screen for the instant the picture is taken.
  bar.hidden = true;
  const hadPreview = !preview.hidden;
  preview.hidden = true;
  try {
    const blob = await ctx.capture();
    if (!active) return;
    flash();
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), URL_LIFE_MS);
    save(url);
    showPreview(url, blob);
  } catch {
    if (active) {
      preview.hidden = !hadPreview;
      const text = 'Could not take the photo. Try again.';
      ctx.toast(text);
      // The room's own toast is part of the hidden interface, so say it in the bar as well.
      say(text);
    }
  } finally {
    busy = false;
    bar.hidden = false;
  }
}

/** The Take photo button, Space and Enter: shoot now, start the countdown, or call a running countdown off. */
function trigger() {
  if (!active || busy) return;
  if (countdownTimer) {
    stopCountdown();
    return;
  }
  if (!timerOn) {
    void shoot();
    return;
  }
  let left = COUNTDOWN;
  countEl.textContent = String(left);
  countEl.hidden = false;
  shootBtn.textContent = 'Cancel';
  countdownTimer = window.setInterval(() => {
    left--;
    if (left > 0) {
      countEl.textContent = String(left);
      return;
    }
    stopCountdown();
    void shoot();
  }, 1000);
}

function setTimer(on: boolean) {
  timerOn = on;
  timerBtn.classList.toggle('on', on);
  timerBtn.setAttribute('aria-pressed', String(on));
  ctx.store.set('photo-timer', on ? '1' : '0');
  if (!on) stopCountdown();
}

function enter() {
  if (active) return;
  active = true;
  say('');
  root.hidden = false;
  bar.hidden = false;
  ctx.setUiHidden(true);
  // A button of the hidden interface may still have the focus, and Space or Enter would press it.
  if (document.activeElement instanceof HTMLElement && ctx.hud.contains(document.activeElement)) document.activeElement.blur();
}

function leave() {
  if (!active) return;
  active = false;
  stopCountdown();
  hidePreview();
  root.hidden = true;
  ctx.setUiHidden(false);
}

export const feature: Feature = {
  init(c) {
    ctx = c;

    const open = button('ft-photo-open', '', enter);
    open.title = 'Photo mode (P)';
    open.setAttribute('aria-label', 'Photo mode');
    open.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>';
    ctx.topbar.append(open);

    // Everything of ours lives outside the interface that photo mode hides.
    root = el('div', 'ft-photo');
    root.hidden = true;
    flashEl = el('div', 'ft-photo-flash');
    countEl = el('div', 'ft-photo-count');
    countEl.hidden = true;
    countEl.setAttribute('aria-live', 'assertive');

    preview = el('div', 'ft-photo-preview');
    preview.hidden = true;
    previewImg = el('img', 'ft-photo-thumb');
    previewImg.alt = 'The photo you just took';
    copyBtn = button('ft-photo-copy', 'Copy', () => void copy());
    preview.append(previewImg, el('span', 'ft-photo-saved', 'Saved'), copyBtn);

    statusEl = el('div', 'ft-photo-status');
    statusEl.hidden = true;
    statusEl.setAttribute('role', 'status');

    bar = el('div', 'ft-photo-bar');
    shootBtn = button('ft-photo-shoot', 'Take photo', trigger);
    shootBtn.title = 'Space or Enter';
    timerBtn = button('ft-photo-timer', '3s timer', () => setTimer(!timerOn));
    const doneBtn = button('ft-photo-done', 'Done', leave);
    doneBtn.title = 'P or Escape';
    bar.append(shootBtn, timerBtn, doneBtn);

    root.append(flashEl, countEl, preview, statusEl, bar);
    document.body.append(root);

    timerOn = ctx.store.get('photo-timer') === '1';
    timerBtn.classList.toggle('on', timerOn);
    timerBtn.setAttribute('aria-pressed', String(timerOn));

    ctx.on((e) => {
      // The room puts its own screen up when the connection drops: do not leave it hidden.
      if (e.kind === 'lost') leave();
    });
  },

  key(code) {
    if (!active) {
      if (code !== 'KeyP') return false;
      enter();
      return true;
    }
    if (code === 'KeyP' || code === 'Escape') {
      leave();
      return true;
    }
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      // If one of our buttons has the focus (reached with Tab) the browser presses it with this same key.
      const focused = document.activeElement;
      if (!(focused instanceof HTMLButtonElement && root.contains(focused))) trigger();
      return true;
    }
    return false;
  },
};
