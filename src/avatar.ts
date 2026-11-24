import * as THREE from 'three';
import type { PlayerInfo } from '../shared/protocol';

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

export function disposeSprite(s: THREE.Sprite) {
  s.removeFromParent();
  s.material.map?.dispose();
  s.material.dispose();
}

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
  private legs: THREE.Object3D[] = [];
  private arms: THREE.Object3D[] = [];
  private phase = 0;
  private bubble: THREE.Sprite | null = null;
  private bubbleUntil = 0;
  private video: { holder: THREE.Group; tex: THREE.VideoTexture; el: HTMLVideoElement; ring: THREE.Mesh; aspect: number } | null =
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

    this.hold.position.set(0, 1.0, 0.62);
    this.inner.add(this.hold);

    const label = textSprite(info.name, 0.42);
    label.position.y = 2.72;
    this.group.add(this.inner, label);
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.y = this.ry;
  }

  setTarget(x: number, z: number, ry: number) {
    this.tx = x;
    this.tz = z;
    this.try_ = ry;
  }

  /** Jump straight to a spot (used when sitting down). */
  place(x: number, z: number, ry: number) {
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.ry = this.try_ = ry;
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
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.82, 40),
      new THREE.MeshBasicMaterial({ color: this.info.color, toneMapped: false }),
    );
    holder.add(face, ring);
    holder.position.y = 3.75;
    this.group.add(holder);
    this.video = { holder, tex, el, ring, aspect: 0 };
  }

  setSpeaking(on: boolean) {
    if (!this.video) return;
    (this.video.ring.material as THREE.MeshBasicMaterial).color.set(on ? '#9be564' : this.info.color);
  }

  update(dt: number, camera: THREE.Camera) {
    if (!this.local) {
      const k = 1 - Math.exp(-10 * dt);
      const dx = this.tx - this.x;
      const dz = this.tz - this.z;
      this.walking = !this.seat && Math.hypot(dx, dz) > 0.04;
      this.x += dx * k;
      this.z += dz * k;
      this.ry = lerpAngle(this.ry, this.try_, k);
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

    if (this.bubble && performance.now() > this.bubbleUntil) {
      disposeSprite(this.bubble);
      this.bubble = null;
    }

    if (this.video) {
      // Face the camera regardless of which way the body is turned.
      this.video.holder.quaternion.copy(this.group.quaternion).invert().multiply(camera.quaternion);
      // Crop the picture to a centred square so it fills the circle.
      const { el, tex } = this.video;
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
    this.setVideo(null);
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose();
        o.material.dispose();
      }
    });
  }
}
