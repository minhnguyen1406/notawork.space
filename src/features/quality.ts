import type { Feature, FeatureCtx } from './api';
import type { Media, ShareQuality } from '../media';
import './quality.css';

const KEY = 'shareQuality';
const COST = 'Sharper picture, uses about 2.5× the data';
const CHECK_EVERY = 0.5; // seconds between looks at whether voice is connected

let ctx: FeatureCtx;
let box: HTMLElement;
let chosen: ShareQuality = 'standard';
const buttons = new Map<ShareQuality, HTMLButtonElement>();
// The voice connection the choice was last given to: it is replaced on every reconnect.
let applied: Media | null = null;
let sinceCheck = CHECK_EVERY;

function paint() {
  for (const [q, b] of buttons) {
    b.classList.toggle('ft-quality-picked', q === chosen);
    b.setAttribute('aria-checked', String(q === chosen));
  }
}

function choose(q: ShareQuality) {
  if (q === chosen) return;
  chosen = q;
  paint();
  ctx.store.set(KEY, q);
  const m = ctx.media();
  if (!m) return;
  m.shareQuality = q;
  // A running share keeps the quality it started with: restarting it would bring the picker back up.
  if (m.sharingMyScreen) ctx.toast('Stop and share again to use the new quality');
}

function option(q: ShareQuality, label: string, title: string) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ft-quality-option';
  b.dataset.quality = q;
  b.textContent = label;
  b.title = title;
  b.setAttribute('role', 'radio');
  b.onclick = () => choose(q);
  buttons.set(q, b);
  return b;
}

export const feature: Feature = {
  init(c) {
    ctx = c;
    if (ctx.store.get(KEY) === 'sharp') chosen = 'sharp';

    box = document.createElement('span');
    box.className = 'ft-quality';
    box.hidden = true; // until voice connects, like the share button itself
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', 'Screenshare quality');
    box.title = COST.replace('Sharper picture', 'Sharp: sharper picture');
    box.append(option('standard', 'Standard', 'Standard: 720p'), option('sharp', 'Sharp 1080p', COST));
    paint();

    // Right after the share button when it is where we expect, otherwise at the end of the bar.
    const share = ctx.topbar.querySelector('#btn-share');
    if (share) share.after(box);
    else ctx.topbar.append(box);
  },

  frame(dt) {
    sinceCheck += dt;
    if (sinceCheck < CHECK_EVERY) return;
    sinceCheck = 0;
    const m = ctx.media();
    box.hidden = !m;
    if (m && m !== applied) m.shareQuality = chosen;
    applied = m;
  },
};
