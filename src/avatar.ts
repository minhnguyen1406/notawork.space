import * as THREE from 'three';
import type { PlayerInfo } from '../shared/protocol';
import { characterFor, makeCharacter, type Character } from './characters';

const SKIN = ['#f3cfae', '#e3b185', '#c98d5c', '#93603f'];
const HAIR = ['#2b1d16', '#4a2f1d', '#141218', '#7a4a22', '#c9a15a'];

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const flat = (color: string) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 });

/** A piece of text that always faces the camera. `height` is in world units. */
export function textSprite(text: string, height: number, opts: { bg?: string; fg?: string } = {}): THREE.Sprite {
  const font = '600 44px ui-rounded, system-ui, sans-serif';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 44;
  const h = 72;
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = opts.bg ?? 'rgba(20, 16, 24, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 26);
  ctx.fill();
  ctx.fillStyle = opts.fg ?? '#f6ecdd';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.set((height * w) / h, height, 1);
  return sprite;
}

/** A single emoji that always faces the camera. */
export function emojiSprite(emoji: string, size: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 64, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sprite.scale.setScalar(size);
  return sprite;
}

export function disposeSprite(s: THREE.Sprite) {
  s.removeFromParent();
  s.material.map?.dispose();
  s.material.dispose();
}

/** How far in the past other people are shown, so there are always two known positions to glide between. */
const PLAYBACK_DELAY_MS = 130;

const lerpAngle = (a: number, b: number, k: number) => {
  const d = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + d * k;
};

export class Avatar {
  readonly group = new THREE.Group();
  /** Things this avatar is carrying get parented here. */
  readonly hold = new THREE.Group();
  x: number;
  z: number;
  ry: number;
  seat: string | null;
  /** True for the player's own avatar, which is moved directly rather than interpolated. */
  local = false;
  walking = false;

  private tx: number;
  private tz: number;
  private try_: number;
  private inner = new THREE.Group();
  /** The stand-in body made of simple shapes. */
  private rough = new THREE.Group();
  private character: Character | null = null;
  private gone = false;
  private lastX = 0;
  private lastZ = 0;
  private pace = 0;
  private legs: THREE.Object3D[] = [];
  private arms: THREE.Object3D[] = [];
  private phase = 0;
  private bubble: THREE.Sprite | null = null;
  private bubbleUntil = 0;
  private video: { holder: THREE.Group; tex: THREE.VideoTexture; el: HTMLVideoElement; ring: THREE.Mesh; face: THREE.Mesh; aspect: number } | null =
    null;

  constructor(readonly info: PlayerInfo) {
    this.x = this.tx = info.x;
    this.z = this.tz = info.z;
    this.ry = this.try_ = info.ry;
    this.seat = info.seat;

    const h = hash(info.id);
    const skin = flat(SKIN[h % SKIN.length]);
    const shirt = flat(info.color);
    const trousers = flat('#3a3550');

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.42, 3, 8), shirt);
    body.position.y = 1.02;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 8), skin);
    head.position.y = 1.86;
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.41, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.52),
      flat(HAIR[(h >> 3) % HAIR.length]),
    );
    hair.position.set(0, 1.9, -0.03);
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#1b1620' });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), eyeMat);
      eye.position.set(side * 0.14, 1.86, 0.35);
      this.inner.add(eye);

      const leg = new THREE.Group();
      leg.position.set(side * 0.17, 0.62, 0);
      const shin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.6, 0.24), trousers);
      shin.position.y = -0.3;
      leg.add(shin);
      this.legs.push(leg);
      this.inner.add(leg);

      const arm = new THREE.Group();
      arm.position.set(side * 0.46, 1.32, 0);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.36, 2, 6), shirt);
      fore.position.y = -0.24;
      arm.add(fore);
      this.arms.push(arm);
      this.inner.add(arm);
    }
    this.inner.add(body, head, hair);
    this.inner.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });

    // The simple shapes above are a stand-in: they show at once, and give way to the animated
    // character model as soon as it has loaded (or stay, if it can't be fetched).
    this.rough.add(...this.inner.children);
    this.inner.add(this.rough);
    void makeCharacter(characterFor(info.look))
      .then((c) => {
        if (this.gone) return;
        this.character = c;
        this.rough.visible = false;
        this.inner.add(c.root);
      })
      .catch((err) => console.warn('character model unavailable, keeping the simple one', err));

    // A ring in your chosen colour, so friends can tell who is who at a glance.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.85 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    this.group.add(ring);
    this.footRing = ring;

    // Shown while this person is talking: green ripples spreading out from their feet, and their
    // name tag turns bright green with a speaker on it (see setSpeaking).
    for (let i = 0; i < 3; i++) {
      const wave = new THREE.Mesh(
        new THREE.RingGeometry(0.56, 0.7, 40),
        new THREE.MeshBasicMaterial({ color: '#5dff6e', transparent: true, opacity: 0, depthWrite: false }),
      );
      wave.rotation.x = -Math.PI / 2;
      wave.position.y = 0.04;
      wave.visible = false;
      this.waves.push(wave);
      this.group.add(wave);
    }

    this.hold.position.set(0, 1.0, 0.62);
    this.inner.add(this.hold);

    const label = textSprite(info.name, 0.42);
    label.position.y = 2.72;
    this.label = label;
    this.talkLabel = textSprite(`🔊 ${info.name}`, 0.5, { bg: '#3ee05a', fg: '#062a10' });
    this.talkLabel.position.y = 2.76;
    this.talkLabel.visible = false;
    this.group.add(this.inner, label, this.talkLabel);
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.ry;
  }

  /** Recent positions from the server, oldest first, for smooth playback. */
  private path: { t: number; x: number; z: number; ry: number }[] = [];

  setTarget(x: number, z: number, ry: number) {
    this.tx = x;
    this.tz = z;
    this.try_ = ry;
    this.path.push({ t: performance.now(), x, z, ry });
    if (this.path.length > 12) this.path.shift();
  }

  /** Jump straight to a spot (used when sitting down). */
  place(x: number, z: number, ry: number) {
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.ry = this.try_ = ry;
    this.path.length = 0;
  }

  private footRing!: THREE.Mesh;
  private label!: THREE.Sprite;
  private talkLabel!: THREE.Sprite;
  private waves: THREE.Mesh[] = [];
  speaking = false;
  private videoTime = -1;
  /** True if this person's camera bubble is drawn mirrored (only ever your own). */
  get mirrored() {
    return this.video ? this.video.face.scale.x < 0 : false;
  }
  /** How many camera frames have been copied into the 3D bubble (for the tests). */
  get videoFrames() {
    return this.video?.tex.version ?? 0;
  }
  private floats: { sprite: THREE.Sprite; born: number; life: number }[] = [];
  private danceUntil = 0;

  /** A reaction that floats up over the head, a dance, or a snooze. */
  emote(k: string) {
    const now = performance.now();
    if (k === 'dance') {
      this.danceUntil = now + 4500;
      return;
    }
    const sprite = emojiSprite(k === 'zzz' ? '💤' : k, 0.9);
    sprite.position.set((Math.random() - 0.5) * 0.5, this.video ? 4.6 : 3.1, 0);
    this.group.add(sprite);
    this.floats.push({ sprite, born: now, life: k === 'zzz' ? 3200 : 1900 });
  }

  say(text: string) {
    if (this.bubble) disposeSprite(this.bubble);
    const short = text.length > 60 ? text.slice(0, 57) + '…' : text;
    this.bubble = textSprite(short, 0.44, { bg: 'rgba(246, 236, 221, 0.95)', fg: '#1b1620' });
    this.bubble.position.y = this.video ? 4.75 : 3.3;
    this.group.add(this.bubble);
    this.bubbleUntil = performance.now() + 5500;
  }

  /** Show (or remove) this person's live camera above their head. */
  setVideo(el: HTMLVideoElement | null) {
    if (this.video) {
      this.video.holder.removeFromParent();
      this.video.tex.dispose();
      this.video.holder.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.video = null;
    }
    if (!el) return;
    const tex = new THREE.VideoTexture(el);
    tex.colorSpace = THREE.SRGBColorSpace;
    const holder = new THREE.Group();
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.72, 40),
      // Double-sided so it still shows when flipped for the mirror view (see update).
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.82, 40),
      new THREE.MeshBasicMaterial({ color: this.info.color, toneMapped: false }),
    );
    holder.add(face, ring);
    holder.position.y = 3.75;
    this.group.add(holder);
    this.video = { holder, tex, el, ring, face, aspect: 0 };
  }

  /** Mark this person as talking (or not): a speaker icon, a pulsing green ring, and the camera rim. */
  setSpeaking(on: boolean) {
    this.speaking = on;
    this.label.visible = !on;
    this.talkLabel.visible = on;
    for (const w of this.waves) w.visible = on;
    (this.footRing.material as THREE.MeshBasicMaterial).color.set(on ? '#5dff6e' : this.info.color);
    if (this.video) (this.video.ring.material as THREE.MeshBasicMaterial).color.set(on ? '#9be564' : this.info.color);
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.local) {
      // Positions arrive ten times a second. Rather than chase the newest one (which lurches),
      // show where they were a moment ago and glide between the two positions either side of that.
      const at = performance.now() - PLAYBACK_DELAY_MS;
      const p = this.path;
      let goalX = this.tx;
      let goalZ = this.tz;
      let goalRy = this.try_;
      for (let i = p.length - 1; i > 0; i--) {
        if (p[i - 1].t <= at && at <= p[i].t) {
          const k = (at - p[i - 1].t) / Math.max(1, p[i].t - p[i - 1].t);
          goalX = p[i - 1].x + (p[i].x - p[i - 1].x) * k;
          goalZ = p[i - 1].z + (p[i].z - p[i - 1].z) * k;
          goalRy = lerpAngle(p[i - 1].ry, p[i].ry, k);
          break;
        }
      }
      const dx = goalX - this.x;
      const dz = goalZ - this.z;
      const far = Math.hypot(dx, dz);
      // A light touch of easing hides the joins; a big gap (a teleport, a long pause) just snaps.
      const k = far > 6 ? 1 : 1 - Math.exp(-22 * dt);
      this.walking = !this.seat && Math.hypot(this.tx - this.x, this.tz - this.z) > 0.06;
      this.x += dx * k;
      this.z += dz * k;
      this.ry = lerpAngle(this.ry, goalRy, 1 - Math.exp(-14 * dt));
    }
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.ry;

    // Walk cycle, or a seated pose.
    const sitting = this.seat !== null;
    if (this.walking) this.phase += dt * 11;
    const swing = this.walking ? Math.sin(this.phase) * 0.75 : 0;
    this.legs[0].rotation.x = sitting ? -1.45 : swing;
    this.legs[1].rotation.x = sitting ? -1.45 : -swing;
    this.arms[0].rotation.x = this.hold.children.length ? -1.1 : -swing * 0.8;
    this.arms[1].rotation.x = this.hold.children.length ? -1.1 : swing * 0.8;
    const targetY = sitting ? -0.12 : this.walking ? Math.abs(Math.sin(this.phase)) * 0.06 : 0;
    this.inner.position.y += (targetY - this.inner.position.y) * Math.min(1, dt * 14);

    const now = performance.now();
    if (this.speaking) {
      // Ripples: each ring grows outwards and fades, one after another.
      this.waves.forEach((w, i) => {
        const t = (now / 1100 + i / this.waves.length) % 1;
        w.scale.setScalar(1 + t * 2.4);
        (w.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.85;
      });
    }
    // Dancing: spin, bounce, arms in the air.
    const dancing = now < this.danceUntil && !sitting && !this.walking;

    // The animated model: pick the animation that matches what this person is doing.
    if (this.character) {
      const moved = Math.hypot(this.x - this.lastX, this.z - this.lastZ) / Math.max(dt, 0.001);
      this.pace += (moved - this.pace) * Math.min(1, dt * 8);
      const c = this.character;
      // The sitting animation sits on the ground, so lift the model onto whatever it is sitting on.
      const perch = !sitting ? 0 : this.seat!.startsWith('cinema') ? 0.42 : this.seat!.startsWith('lounge') ? 0.62 : 0.74;
      c.root.position.y += (perch - c.root.position.y) * Math.min(1, dt * 12);
      if (sitting) c.play('sit');
      else if (dancing) c.play('emote-yes', 1.8);
      else if (this.walking) this.pace > 6.6 ? c.play('sprint', 1.15) : c.play('walk', Math.max(0.7, this.pace / 4.2));
      else if (this.hold.children.length) c.play('holding-both');
      else c.play('idle');
      c.mixer.update(dt);
    }
    this.lastX = this.x;
    this.lastZ = this.z;
    if (dancing) {
      const t = now / 1000;
      this.inner.rotation.y = Math.sin(t * 5) * 0.9;
      this.inner.position.y = Math.abs(Math.sin(t * 9)) * 0.22;
      this.arms[0].rotation.x = -2.7 + Math.sin(t * 9) * 0.4;
      this.arms[1].rotation.x = -2.7 - Math.sin(t * 9) * 0.4;
      this.legs[0].rotation.x = Math.sin(t * 9) * 0.35;
      this.legs[1].rotation.x = -Math.sin(t * 9) * 0.35;
    } else {
      this.inner.rotation.y *= Math.max(0, 1 - dt * 10);
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      const age = (now - f.born) / f.life;
      if (age >= 1) {
        disposeSprite(f.sprite);
        this.floats.splice(i, 1);
        continue;
      }
      f.sprite.position.y += dt * 0.9;
      f.sprite.material.opacity = age < 0.7 ? 1 : (1 - age) / 0.3;
      f.sprite.scale.setScalar(0.9 * Math.min(1, age * 8));
    }

    if (this.bubble && performance.now() > this.bubbleUntil) {
      disposeSprite(this.bubble);
      this.bubble = null;
    }

    if (this.video) {
      // Face the camera regardless of which way the body is turned.
      this.video.holder.quaternion.copy(this.group.quaternion).invert().multiply(camera.quaternion);
      // Crop the picture to a centred square so it fills the circle.
      const { el, tex } = this.video;
      // You see yourself as in a mirror, like FaceTime and Zoom; everyone else sees you the true way round.
      this.video.face.scale.x = this.local ? -1 : 1;
      // Copy each new camera frame ourselves; see the note on the cinema screen in world.ts.
      if (el.readyState >= 2 && el.currentTime !== this.videoTime) {
        this.videoTime = el.currentTime;
        tex.needsUpdate = true;
      }
      const aspect = el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 0;
      if (aspect && aspect !== this.video.aspect) {
        this.video.aspect = aspect;
        if (aspect >= 1) {
          tex.repeat.set(1 / aspect, 1);
          tex.offset.set((1 - 1 / aspect) / 2, 0);
        } else {
          tex.repeat.set(1, aspect);
          tex.offset.set(0, (1 - aspect) / 2);
        }
      }
    }
  }

  dispose() {
    this.gone = true;
    this.setVideo(null);
    this.group.removeFromParent();
    this.character?.mixer.stopAllAction();
    // The model's geometry is shared by everyone using that character, so leave it alone.
    this.character?.root.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}
