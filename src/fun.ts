import * as THREE from 'three';

// ---------------------------------------------------------------- small sounds, made on the spot

let audio: AudioContext | null = null;
const VOLUME = 0.07;

function tone(freq: number, start: number, length: number, type: OscillatorType = 'sine', slideTo?: number) {
  if (!audio) return;
  const t = audio.currentTime + start;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + length);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(VOLUME, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length + 0.05);
}

export type Sound = 'pop' | 'horn' | 'alarm' | 'tada';

/** Play a short effect. Silent until the browser has allowed sound (after the first click). */
export function play(sound: Sound) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {
    return;
  }
  if (sound === 'pop') tone(520, 0, 0.12, 'sine', 880);
  else if (sound === 'horn') for (const f of [233, 294, 349]) tone(f, 0, 0.9, 'sawtooth');
  else if (sound === 'alarm') for (let i = 0; i < 3; i++) tone(880, i * 0.28, 0.2, 'square', 440);
  else for (const [i, f] of [523, 659, 784, 1047].entries()) tone(f, i * 0.11, 0.35, 'triangle');
}

// ---------------------------------------------------------------- confetti over the whole window

const PIECES = ['🎉', '🎊', '✨', '🥳', '⭐'];

export function confetti(pieces = PIECES, count = 46) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'confetti';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.textContent = pieces[i % pieces.length];
    p.style.left = `${Math.random() * 100}%`;
    p.style.fontSize = `${18 + Math.random() * 22}px`;
    p.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    p.style.animationDelay = `${Math.random() * 0.5}s`;
    p.style.setProperty('--drift', `${(Math.random() - 0.5) * 240}px`);
    layer.append(p);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4200);
}

/** A red pulse round the edge of the window. */
export function flash() {
  const el = document.createElement('div');
  el.className = 'work-flash';
  document.body.append(el);
  setTimeout(() => el.remove(), 1800);
}

// ---------------------------------------------------------------- the "minutes since work" sign

/** A sign that counts the minutes since anyone mentioned work in chat. Faces +z. */
export class WorkSign {
  readonly group = new THREE.Group();
  private canvas = document.createElement('canvas');
  private tex: THREE.CanvasTexture;
  private at: number | null = null;
  private by = '';
  private shown = '';
  private opened = Date.now();

  constructor(w: number, h: number) {
    this.canvas.width = 1024;
    this.canvas.height = Math.round((1024 * h) / w);
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.3), new THREE.MeshStandardMaterial({ color: '#17131f', roughness: 0.6 }));
    frame.position.z = -0.17;
    this.group.add(frame, new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex })));
    this.update();
  }

  /** `at` is when work was last mentioned (this computer's clock), or null if never. */
  set(at: number | null, by: string) {
    this.at = at;
    this.by = by;
    this.update();
  }

  update() {
    const minutes = Math.floor((Date.now() - (this.at ?? this.opened)) / 60_000);
    const key = `${minutes}|${this.by}|${this.at === null}`;
    if (key === this.shown) return;
    this.shown = key;
    const { width: w, height: h } = this.canvas;
    const g = this.canvas.getContext('2d')!;
    const font = 'ui-rounded, system-ui, sans-serif';
    g.fillStyle = '#f3c614';
    g.fillRect(0, 0, w, h);
    // Hazard stripes top and bottom, like a factory safety board.
    for (const y of [0, h - 46]) {
      g.save();
      g.beginPath();
      g.rect(0, y, w, 46);
      g.clip();
      g.fillStyle = '#17131f';
      for (let x = -60; x < w + 60; x += 80) {
        g.beginPath();
        g.moveTo(x, y + 46);
        g.lineTo(x + 40, y + 46);
        g.lineTo(x + 86, y);
        g.lineTo(x + 46, y);
        g.fill();
      }
      g.restore();
    }
    g.fillStyle = '#17131f';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 58px ${font}`;
    g.fillText('THIS ROOFTOP HAS GONE', w / 2, 106);
    g.font = `900 ${Math.round(h * 0.34)}px ${font}`;
    g.fillText(String(minutes), w / 2, h * 0.47);
    g.font = `800 58px ${font}`;
    g.fillText(minutes === 1 ? 'MINUTE WITHOUT WORK TALK' : 'MINUTES WITHOUT WORK TALK', w / 2, h * 0.72);
    g.font = `600 40px ${font}`;
    g.fillText(this.at === null ? 'A clean record. Keep it that way.' : `Last offender: ${this.by}`.slice(0, 44), w / 2, h * 0.84);
    this.tex.needsUpdate = true;
  }
}
