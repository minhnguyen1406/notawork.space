import * as THREE from 'three';
import type { Board } from '../shared/protocol';
import {
  BILLBOARD,
  NEWS_WALL,
  BOUNDS,
  CENTRE,
  DINING,
  LOUNGE,
  MAST_H,
  MASTS,
  PERGOLA,
  PERGOLA_POSTS,
  PLANTS,
  SCREEN,
  SEATS,
} from '../shared/layout';
import { textSprite } from './avatar';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { Billboard } from './billboard';
import { WorkSign } from './fun';
import { furnish } from './furniture';

export interface World {
  scene: THREE.Scene;
  /** Put a live video on the cinema screen, or pass null to go back to the idle card. */
  setScreenVideo(el: HTMLVideoElement | null): void;
  /** How many shared-video frames have been copied onto the cinema screen (for the tests). */
  screenFrames(): number;
  setBoard(board: Board): void;
  /** When work was last mentioned in chat (this computer's clock), or null if never. */
  setWork(at: number | null, by: string): void;
  update(time: number, dt: number): void;
}

const mats = new Map<string, THREE.MeshStandardMaterial>();
export const mat = (color: string) => {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });
    mats.set(color, m);
  }
  return m;
};

/** An unlit material brighter than white, so the bloom pass makes it glow. */
export const glow = (color: string, strength = 2.5) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength) });

export function box(w: number, h: number, d: number, color: string, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function idleScreenTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 576;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 576);
  grad.addColorStop(0, '#231a35');
  grad.addColorStop(1, '#0f0b17');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 576);
  g.textAlign = 'center';
  g.fillStyle = '#f6ecdd';
  g.font = '700 64px ui-rounded, system-ui, sans-serif';
  g.fillText('Nothing playing', 512, 270);
  g.fillStyle = '#b9a998';
  g.font = '500 30px ui-rounded, system-ui, sans-serif';
  g.fillText('Press “Share screen” to put something on', 512, 330);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A neon-style sign: glowing text on a transparent plane. */
function neonSign(text: string, color: string, height: number) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = '800 120px ui-rounded, system-ui, sans-serif';
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 80;
  c.height = 200;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = color;
  g.shadowBlur = 28;
  g.fillStyle = color;
  g.fillText(text, c.width / 2, 104);
  g.shadowBlur = 0;
  g.fillStyle = '#ffffff';
  g.globalAlpha = 0.7;
  g.fillText(text, c.width / 2, 104);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry((height * c.width) / c.height, height),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      color: new THREE.Color(1.9, 1.9, 1.9),
      side: THREE.DoubleSide,
    }),
  );
  return m;
}

function plant(x: number, z: number, scale = 1) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.32, 0.6, 8), mat('#b0603f'));
  pot.position.y = 0.3;
  g.add(pot);
  for (let i = 0; i < 3; i++) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.62 - i * 0.14, 0.9, 7), mat(i % 2 ? '#5f9d4c' : '#4b8a43'));
    leaf.position.y = 0.95 + i * 0.5;
    g.add(leaf);
  }
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  return g;
}

/** A dusk sky: warm at the horizon, deep blue overhead. */
function sky() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(420, 24, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        varying vec3 vDir;
        void main(){
          float h = vDir.y;
          vec3 ground = vec3(0.07, 0.055, 0.11);
          vec3 horizon = vec3(1.0, 0.52, 0.30);
          vec3 mid = vec3(0.62, 0.26, 0.42);
          vec3 high = vec3(0.16, 0.14, 0.36);
          vec3 top = vec3(0.04, 0.05, 0.14);
          vec3 c = mix(horizon, mid, smoothstep(0.0, 0.16, h));
          c = mix(c, high, smoothstep(0.1, 0.42, h));
          c = mix(c, top, smoothstep(0.35, 0.95, h));
          c = mix(ground, c, smoothstep(-0.08, 0.0, h));
          // the last of the sun, low in the west
          float sun = pow(max(dot(vDir, normalize(vec3(-1.0, 0.05, 0.25))), 0.0), 10.0);
          c += vec3(1.0, 0.55, 0.25) * sun * 0.7;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }),
  );
  m.renderOrder = -10;
  return m;
}

function stars() {
  const n = 500;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const y = 0.3 + Math.random() * 0.7;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * 400, y * 400, Math.sin(a) * r * 400], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: '#dfe6ff', size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }),
  );
}

/** Things in the skyline that move or blink, advanced each frame. */
interface SkylineLife {
  group: THREE.Group;
  update(time: number): void;
}

/**
 * A modern city around the roof: glass towers that mirror the evening sky, lit floors, neon edge
 * lighting, crowns and spires, and a little air traffic drifting between them.
 */
function skyline(): SkylineLife {
  const g = new THREE.Group();
  let s = 42;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  // One tile of facade: `lit` paints the windows that are on (used as the glow), otherwise the
  // glass itself with faint floor lines.
  const facade = (seed: number, lit: boolean, warm: number) => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const x = c.getContext('2d')!;
    let q = seed;
    const r = () => ((q = (q * 16807) % 2147483647) / 2147483647);
    x.fillStyle = lit ? '#000' : '#1a2733';
    x.fillRect(0, 0, 128, 256);
    const cols = 8;
    const rows = 32;
    for (let row = 0; row < rows; row++) {
      // Whole floors are often lit or dark together, as in a real office tower.
      const floor = r();
      for (let col = 0; col < cols; col++) {
        const on = floor > 0.72 ? r() > 0.25 : floor > 0.3 ? r() > 0.62 : r() > 0.93;
        if (lit) {
          if (!on) continue;
          const v = r();
          x.fillStyle = v < warm ? (v < warm * 0.5 ? '#ffd9a0' : '#ffbe73') : v < 0.93 ? '#bfe3ff' : '#8ff5e6';
          x.globalAlpha = 0.55 + r() * 0.45;
          x.fillRect(col * 16 + 2, row * 8 + 2, 12, 4.5);
        } else {
          x.globalAlpha = 1;
          x.fillStyle = on ? '#243847' : '#16222c';
          x.fillRect(col * 16 + 1, row * 8 + 1, 14, 6);
        }
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  const skins = [0, 1, 2, 3].map((k) => ({ glass: facade(11 + k * 97, false, 0), lights: facade(11 + k * 97, true, [0.7, 0.35, 0.55, 0.15][k]) }));
  const tints = ['#5d8fb0', '#7fa3b8', '#4f7f9c', '#8c9fb5', '#6a8ea6'];
  const neons = ['#39e6ff', '#ff4fd8', '#ffb347', '#7dffb0', '#9d7bff'];

  /** Glass that reflects the sky, with its lit floors glowing through. */
  const glassFor = (w: number, h: number, far: boolean) => {
    const skin = skins[Math.floor(rnd() * skins.length)];
    const glass = skin.glass.clone();
    const lights = skin.lights.clone();
    for (const t of [glass, lights]) t.repeat.set(Math.max(1, Math.round(w / 9)), Math.max(1, Math.round(h / 26)));
    return new THREE.MeshStandardMaterial({
      color: tints[Math.floor(rnd() * tints.length)],
      map: glass,
      metalness: far ? 0.6 : 0.92,
      roughness: far ? 0.45 : 0.16 + rnd() * 0.14,
      emissive: '#ffffff',
      emissiveMap: lights,
      emissiveIntensity: far ? 0.55 : 0.95,
    });
  };

  const beacons: THREE.Mesh[] = [];
  const DEPTH = 150; // how far the towers continue below the roof

  const tower = (x: number, z: number, top: number, w: number, far: boolean) => {
    const kind = rnd();
    const neon = neons[Math.floor(rnd() * neons.length)];
    const h = top + DEPTH;
    const place = (m: THREE.Object3D, y: number) => {
      m.position.set(x, y, z);
      g.add(m);
    };
    let crownY = top;
    let crownR = w / 2;
    if (kind < 0.38) {
      // Stepped tower: two or three tiers, each narrower than the one below.
      const tiers = 2 + Math.floor(rnd() * 2);
      let y0 = -DEPTH;
      let tw = w;
      for (let i = 0; i < tiers; i++) {
        const th = i === tiers - 1 ? top - y0 : (h * (0.5 + rnd() * 0.15)) / (i + 1);
        const m = new THREE.Mesh(new THREE.BoxGeometry(tw, th, tw * (0.8 + rnd() * 0.4)), glassFor(tw, th, far));
        m.rotation.y = rnd() * 0.5;
        place(m, y0 + th / 2);
        y0 += th;
        crownR = tw / 2;
        tw *= 0.72;
      }
    } else if (kind < 0.66) {
      // Round tower, slightly tapered.
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.42, w * 0.56, h, 20, 1), glassFor(w * 3, h, far));
      place(m, top - h / 2);
      crownR = w * 0.42;
    } else if (kind < 0.86) {
      // Slender blade, wide one way and thin the other.
      const m = new THREE.Mesh(new THREE.BoxGeometry(w * 1.25, h, w * 0.5), glassFor(w * 1.25, h, far));
      m.rotation.y = rnd() * Math.PI;
      place(m, top - h / 2);
    } else {
      // Tapered to a point.
      const m = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.12, w * 0.6, h, 4, 1), glassFor(w * 2.4, h, far));
      m.rotation.y = rnd() * Math.PI;
      place(m, top - h / 2);
      crownR = w * 0.12;
    }
    if (far) return;

    // Neon edge lighting running up two corners.
    if (rnd() < 0.55) {
      for (const side of [-1, 1]) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.35, Math.min(h, top + 40), 0.35), glow(neon, 1.9));
        strip.position.set(x + side * crownR * 0.98, top - Math.min(h, top + 40) / 2, z + side * crownR * 0.98);
        g.add(strip);
      }
    }
    // A lit crown.
    if (rnd() < 0.6) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(crownR * 1.05, 0.28, 6, 28), glow(neon, 2.2));
      ring.rotation.x = Math.PI / 2;
      place(ring, crownY + 0.4);
    }
    // A spire with an aircraft warning light on the tallest ones.
    if (top > 34 && rnd() < 0.7) {
      const spire = 10 + rnd() * 16;
      place(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.5, spire, 6), mat('#27313a')), crownY + spire / 2);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), glow('#ff3b3b', 3));
      beacon.userData.phase = rnd() * 6;
      place(beacon, crownY + spire + 0.4);
      beacons.push(beacon);
    }
  };

  // Three rings: a few close giants, a dense middle distance, and a hazy far layer.
  const ring = (count: number, near: number, deep: number, tall: number, far: boolean) => {
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + rnd() * 0.12;
      const dist = near + rnd() * deep;
      // Most reach about roof height; a few soar.
      const top = -18 + rnd() * rnd() * tall + (rnd() < 0.18 ? tall * 0.5 : 0);
      tower(Math.sin(angle) * dist, Math.cos(angle) * dist, top, 11 + rnd() * 13, far);
    }
  };
  ring(22, 78, 34, 70, false);
  ring(40, 125, 70, 95, false);
  ring(60, 215, 130, 130, true);

  // Air traffic: small lights gliding along lanes between the towers.
  const craft: { m: THREE.Mesh; r: number; y: number; speed: number; phase: number }[] = [];
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 6, 5), glow(i % 3 ? '#ffe9b0' : '#ff5a5a', 3));
    g.add(m);
    craft.push({ m, r: 95 + rnd() * 150, y: 14 + rnd() * 60, speed: (rnd() < 0.5 ? 1 : -1) * (0.012 + rnd() * 0.03), phase: rnd() * 6.28 });
  }

  return {
    group: g,
    update(time) {
      for (const c of craft) {
        const a = c.phase + time * c.speed;
        c.m.position.set(Math.sin(a) * c.r, c.y + Math.sin(time * 0.2 + c.phase) * 2, Math.cos(a) * c.r);
      }
      for (const b of beacons) b.visible = (time * 0.8 + b.userData.phase) % 2.4 < 1.5;
    },
  };
}

const ASSETS = import.meta.env.BASE_URL;

/**
 * A real sunset sky: a 360° photograph behind everything, and a high-dynamic-range copy of it to
 * light the scene, so the deck, furniture and glass towers all pick up the same evening colours.
 * (Poly Haven "Belfast Sunset (Pure Sky)", CC0.) The painted stand-ins are removed once it loads.
 */
function loadSky(scene: THREE.Scene, standIns: THREE.Object3D[], hemi: THREE.HemisphereLight, sun: THREE.DirectionalLight) {
  // Turn the photograph so its sunset glow sits to the north, behind the cinema screen.
  const turn = SKY_TURN;
  new THREE.TextureLoader().load(`${ASSETS}sky/dusk-sky.jpg`, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
    scene.backgroundRotation.y = turn;
    scene.backgroundIntensity = 0.9;
    for (const o of standIns) o.removeFromParent();
  });
  new HDRLoader().load(`${ASSETS}sky/dusk-sky-1k.hdr`, (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = tex;
    scene.environmentRotation.y = turn;
    scene.environmentIntensity = 0.5;
    // The sky now does most of the ambient lighting, so the simple fill light steps back.
    hemi.intensity = 0.3;
    sun.intensity = 0.9;
  });
}
const SKY_TURN = 1.75;

/** Real decking: colour, surface bumps and roughness from a photographed wood deck (Poly Haven "Wood Floor Deck", CC0). */
function deckMaterial(metresWide: number, metresDeep: number) {
  const material = new THREE.MeshStandardMaterial({ color: '#8f6a4b', roughness: 0.85 });
  const loader = new THREE.TextureLoader();
  const TILE = 3.2; // metres covered by one copy of the photograph
  const load = (file: string, srgb: boolean, apply: (t: THREE.Texture) => void) =>
    loader.load(`${ASSETS}deck/${file}.jpg`, (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(metresWide / TILE, metresDeep / TILE);
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      apply(t);
      material.needsUpdate = true;
    });
  load('color', true, (t) => {
    material.map = t;
    material.color.set('#b9aca1'); // a light tint: keeps the wood warm under the cool evening sky
  });
  load('normal', false, (t) => (material.normalMap = t));
  load('rough', false, (t) => {
    material.roughnessMap = t;
    material.roughness = 1;
  });
  return material;
}

export function buildWorld(): World {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#77779a', 170, 620);
  // Until the photographed sky arrives (or if it can't be fetched) a painted dusk sky stands in.
  const city = skyline();
  city.group.position.set(CENTRE.x, 0, CENTRE.z);
  scene.add(city.group);
  const standIns = [sky(), stars()];
  scene.add(...standIns);

  // --- Light: cool sky above, warm bounce below, and the last of the sun low behind the cinema,
  // which is where the sunset sits in the photographed sky.
  const hemi = new THREE.HemisphereLight('#8a8fe0', '#ffb07a', 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffb38a', 1.25);
  sun.position.set(CENTRE.x - 26, 24, CENTRE.z - 40);
  loadSky(scene, standIns, hemi, sun);
  sun.target.position.set(CENTRE.x, 0, CENTRE.z);
  scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0005;
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -52;
  sc.right = sc.top = 52;
  sc.far = 150;
  scene.add(sun);

  const B = BOUNDS;
  const W = B.x2 - B.x1;
  const D = B.z2 - B.z1;
  const flatRug = (geo: THREE.BufferGeometry, color: string, x: number, z: number, y = 0.012) => {
    const m = new THREE.Mesh(geo, mat(color));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  // --- The roof: decking, the building underneath, and a parapet with lanterns.
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(W + 1, D + 1), deckMaterial(W + 1, D + 1));
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(CENTRE.x, 0, CENTRE.z);
  deck.receiveShadow = true;
  scene.add(deck);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(W + 1.6, 120, D + 1.6), mat('#3b2f3f'));
  tower.position.set(CENTRE.x, -60.05, CENTRE.z);
  scene.add(tower);

  for (const [x, z, w, d] of [
    [CENTRE.x, B.z1 - 0.5, W + 1.6, 0.6],
    [CENTRE.x, B.z2 + 0.5, W + 1.6, 0.6],
    [B.x1 - 0.5, CENTRE.z, 0.6, D + 1.6],
    [B.x2 + 0.5, CENTRE.z, 0.6, D + 1.6],
  ] as const) {
    scene.add(box(w, 1.0, d, '#77737c', x, 0.5, z));
    scene.add(box(w + 0.2, 0.12, d + 0.2, '#a9a4a8', x, 1.06, z));
  }
  const lanternGeo = new THREE.BoxGeometry(0.34, 0.44, 0.34);
  const lanternMat = glow('#ffb45e', 2.6);
  const lantern = (x: number, z: number) => {
    const l = new THREE.Mesh(lanternGeo, lanternMat);
    l.position.set(x, 1.38, z);
    scene.add(l);
  };
  for (let x = B.x1 + 4; x <= B.x2 - 4; x += 8) {
    lantern(x, B.z1 - 0.5);
    lantern(x, B.z2 + 0.5);
  }
  for (let z = B.z1 + 4; z <= B.z2 - 4; z += 8) {
    lantern(B.x1 - 0.5, z);
    lantern(B.x2 + 0.5, z);
  }

  // --- Masts, cables and string lights; the billboard hangs from the cables.
  const billboard = new Billboard();
  scene.add(billboard.group);
  for (const [kind, side] of [['news', -1], ['stocks', 1]] as const) {
    const panel = billboard.panel(kind, NEWS_WALL.w, NEWS_WALL.h);
    panel.position.set(side * NEWS_WALL.x, NEWS_WALL.y, SCREEN.z + 0.2);
    scene.add(panel);
    for (const dx of [-1, 1]) {
      scene.add(box(0.3, NEWS_WALL.y, 0.3, '#2a2230', side * NEWS_WALL.x + dx * (NEWS_WALL.w / 2 - 0.6), NEWS_WALL.y / 2, SCREEN.z - 0.1));
    }
  }
  const bulbs: THREE.Mesh[] = [];
  const bulbGeo = new THREE.SphereGeometry(0.13, 6, 5);
  const bulbMats = ['#ffd27a', '#ff8a6b', '#8fd3ff', '#b8f28a', '#ff9ad5'].map((c) => glow(c, 2.4));
  const cableMat = new THREE.LineBasicMaterial({ color: '#2a2230' });
  const stringLights = (a: THREE.Vector3, b: THREE.Vector3, sag: number, count: number) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const p = a.clone().lerp(b, t);
      p.y -= Math.sin(t * Math.PI) * sag;
      pts.push(p);
      if (i > 0 && i < count) {
        const bulb = new THREE.Mesh(bulbGeo, bulbMats[(i + bulbs.length) % bulbMats.length]);
        bulb.position.copy(p).y -= 0.14;
        bulb.userData.phase = bulbs.length * 0.7;
        bulbs.push(bulb);
        scene.add(bulb);
      }
    }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
  };
  const hang = new THREE.Vector3(BILLBOARD.x, BILLBOARD.y + BILLBOARD.h / 2 + 0.2, BILLBOARD.z);
  const tops = MASTS.map((m) => new THREE.Vector3(m.x, MAST_H, m.z));
  for (const m of MASTS) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, MAST_H, 8), mat('#3a2f3c'));
    pole.position.set(m.x, MAST_H / 2, m.z);
    pole.castShadow = true;
    scene.add(pole);
  }
  for (const top of tops) stringLights(top, hang, 0.6, 16);
  stringLights(tops[0].clone().setY(9), tops[1].clone().setY(9), 1.6, 26);
  stringLights(tops[2].clone().setY(9), tops[3].clone().setY(9), 1.6, 26);
  stringLights(tops[0].clone().setY(9), tops[2].clone().setY(9), 1.6, 26);
  stringLights(tops[1].clone().setY(9), tops[3].clone().setY(9), 1.6, 26);

  // --- Open-air cinema (north edge)
  flatRug(new THREE.PlaneGeometry(19, 10), '#2b3358', 0, -8.5);
  flatRug(new THREE.PlaneGeometry(17.6, 8.6), '#39437a', 0, -8.5, 0.016);
  const idle = idleScreenTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: idle });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
  screen.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.06);
  screen.scale.set(SCREEN.w, SCREEN.h, 1);
  scene.add(screen);
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), new THREE.MeshBasicMaterial({ color: '#000' }));
  backing.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.04);
  scene.add(backing);
  scene.add(box(SCREEN.w + 0.7, SCREEN.h + 0.7, 0.3, '#2a2230', SCREEN.x, SCREEN.y, SCREEN.z - 0.14));
  for (const side of [-1, 1]) scene.add(box(0.4, SCREEN.y + SCREEN.h / 2, 0.4, '#2a2230', side * (SCREEN.w / 2 + 0.6), (SCREEN.y + SCREEN.h / 2) / 2, SCREEN.z - 0.14));
  const screenGlow = new THREE.PointLight('#8fa8ff', 0, 26, 1.6);
  screenGlow.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 4);
  scene.add(screenGlow);
  const sign = neonSign('notawork.space', '#ff5d8f', 1.5);
  sign.position.set(0, SCREEN.y + SCREEN.h / 2 + 1.35, SCREEN.z + 0.1);
  scene.add(sign);
  scene.add(box(10.4, 1.9, 0.3, '#1d1726', 0, SCREEN.y + SCREEN.h / 2 + 1.35, SCREEN.z - 0.14));

  let screenTex: THREE.VideoTexture | null = null;
  let screenEl: HTMLVideoElement | null = null;
  let screenAspect = 0;
  let screenTime = -1;

  for (const seat of SEATS.filter((s) => s.group === 'cinema')) {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), mat(seat.id.endsWith('0') ? '#c96a4a' : '#d98b5f'));
    bag.scale.set(1, 0.5, 1);
    bag.position.set(seat.x, 0.3, seat.z);
    bag.castShadow = true;
    scene.add(bag);
  }

  // --- Lounge around a fire pit (south-west)
  flatRug(new THREE.CircleGeometry(5.6, 28), '#7d2c38', LOUNGE.x, LOUNGE.z);
  flatRug(new THREE.CircleGeometry(4.9, 28), '#a8404a', LOUNGE.x, LOUNGE.z, 0.016);
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, 0.5, 10), mat('#6a6470'));
  pit.position.set(LOUNGE.x, 0.25, LOUNGE.z);
  pit.castShadow = true;
  scene.add(pit);
  const embers = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.08, 10), glow('#ff5a1f', 2.2));
  embers.position.set(LOUNGE.x, 0.5, LOUNGE.z);
  scene.add(embers);
  const flames: THREE.Mesh[] = [];
  const flameColors = ['#ff7a2a', '#ffb347', '#ffd76a', '#ff5a1f', '#ffa23a'];
  for (let i = 0; i < 5; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.26 + (i % 2) * 0.1, 0.9 + (i % 3) * 0.3, 5), glow(flameColors[i], 2.8));
    const a = (i / 5) * Math.PI * 2;
    f.position.set(LOUNGE.x + Math.cos(a) * 0.34 * (i ? 1 : 0), 0.95, LOUNGE.z + Math.sin(a) * 0.34 * (i ? 1 : 0));
    f.userData.phase = i * 1.7;
    flames.push(f);
    scene.add(f);
  }
  const SPARKS = 36;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkSeed = Array.from({ length: SPARKS }, () => ({ a: Math.random() * 6.28, r: Math.random() * 0.7, speed: 0.6 + Math.random() * 0.9, t: Math.random() }));
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: new THREE.Color('#ffb347').multiplyScalar(3), size: 0.09, transparent: true, depthWrite: false }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  const fireLight = new THREE.PointLight('#ff9a4a', 120, 24, 1.8);
  fireLight.position.set(LOUNGE.x, 1.7, LOUNGE.z);
  scene.add(fireLight);

  const seatColors = ['#4f7a6a', '#c98a3c', '#6a5a8f', '#b0603f'];
  SEATS.filter((s) => s.group === 'lounge').forEach((seat, i) => {
    const chair = new THREE.Group();
    const c = seatColors[i % seatColors.length];
    chair.add(box(1.2, 0.5, 1.1, c, 0, 0.25, 0));
    chair.add(box(1.2, 0.9, 0.25, c, 0, 0.7, -0.55));
    chair.add(box(0.2, 0.35, 1.1, c, -0.6, 0.6, 0));
    chair.add(box(0.2, 0.35, 1.1, c, 0.6, 0.6, 0));
    chair.position.set(seat.x, 0, seat.z);
    chair.rotation.y = seat.ry;
    scene.add(chair);
    furnish(scene, 'loungeChair', { x: seat.x, z: seat.z, ry: seat.ry, w: 1.4, h: 1.15, d: 1.25, back: 0.1, tint: { carpet: c, wood: '#5e3e29' } }, [chair]);
  });
  // Low tables between every other pair of armchairs, with a lamp or a plant on each.
  for (let i = 0; i < 4; i++) {
    const a = ((i * 2 + 0.5) / 8) * Math.PI * 2;
    const x = LOUNGE.x + Math.sin(a) * 3.85;
    const z = LOUNGE.z + Math.cos(a) * 3.85;
    furnish(scene, 'tableCoffeeSquare', { x, z, ry: a, w: 0.7, h: 0.5, d: 0.7, tint: { wood: '#7a5236' } });
    if (i % 2) furnish(scene, 'lampRoundTable', { x, y: 0.5, z, h: 0.62, tint: { metal: '#3a2f3c' } });
    else furnish(scene, i ? 'plantSmall2' : 'plantSmall1', { x, y: 0.5, z, h: 0.42, tint: { wood: '#b0603f' } });
  }

  // --- Dining table (by the kitchen)
  const diningTable = [box(1.8, 0.12, 5.8, '#7a5236', DINING.x, 0.9, DINING.z)];
  for (const dx of [-0.7, 0.7])
    for (const dz of [-2.6, 2.6]) diningTable.push(box(0.16, 0.86, 0.16, '#5e3e29', DINING.x + dx, 0.43, DINING.z + dz));
  scene.add(...diningTable);
  // Two tables pushed together end to end, each with a runner, on a rug.
  for (const side of [-1, 1]) {
    furnish(
      scene,
      'tableCloth',
      { x: DINING.x, z: DINING.z + side * 1.45, ry: Math.PI / 2, w: 2.9, h: 0.96, d: 1.8, tint: { wood: '#7a5236', carpet: '#7d2c38' } },
      side < 0 ? diningTable : [],
    );
  }
  furnish(scene, 'rugRectangle', { x: DINING.x, y: 0.014, z: DINING.z, ry: Math.PI / 2, w: 7.8, h: 0.03, d: 5.4, tint: { carpet: '#3d5266', carpetDarker: '#2b3a4c' } });
  for (const seat of SEATS.filter((s) => s.group === 'dining')) {
    const chair = new THREE.Group();
    chair.add(box(0.8, 0.12, 0.8, '#c9a26b', 0, 0.5, 0));
    chair.add(box(0.8, 0.8, 0.1, '#c9a26b', 0, 0.9, -0.38));
    for (const dx of [-0.32, 0.32]) for (const dz of [-0.32, 0.32]) chair.add(box(0.08, 0.5, 0.08, '#8a6a44', dx, 0.25, dz));
    chair.position.set(seat.x, 0, seat.z);
    chair.rotation.y = seat.ry;
    scene.add(chair);
    furnish(scene, 'chairCushion', { x: seat.x, z: seat.z, ry: seat.ry, w: 0.8, h: 1.3, d: 0.8, tint: { wood: '#c9a26b', carpet: '#b0603f' } }, [chair]);
  }
  for (const dz of [-1.6, 1.6]) {
    const candle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), glow('#ffc26a', 2.6));
    candle.position.set(DINING.x - 0.55, 1.12, DINING.z + dz);
    scene.add(candle, box(0.12, 0.14, 0.12, '#efe8da', DINING.x - 0.55, 1.0, DINING.z + dz));
  }
  const diningLight = new THREE.PointLight('#ffc98a', 30, 12, 1.8);
  diningLight.position.set(DINING.x, 2.4, DINING.z);
  scene.add(diningLight);

  // --- Kitchen under a pergola (east)
  flatRug(new THREE.PlaneGeometry(9.4, 17.6), '#d5dbd6', 15.3, 3);
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 5; j++)
      if ((i + j) % 2 === 0) flatRug(new THREE.PlaneGeometry(1.88, 1.955), '#bcc6c1', 11.54 + j * 1.88, -4.82 + i * 1.955, 0.016);
  const P = PERGOLA;
  for (const p of PERGOLA_POSTS) scene.add(box(0.3, P.h, 0.3, '#6f4a32', p.x, P.h / 2, p.z));
  const pw = P.x2 - P.x1;
  const pd = P.z2 - P.z1;
  for (const z of [P.z1, P.z2]) scene.add(box(pw + 0.8, 0.26, 0.3, '#6f4a32', (P.x1 + P.x2) / 2, P.h, z));
  for (let x = P.x1; x <= P.x2 + 0.01; x += pw / 8) scene.add(box(0.16, 0.2, pd + 1.2, '#8a5f40', x, P.h + 0.22, (P.z1 + P.z2) / 2));
  for (const z of [-1.5, 3, 7.5]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), glow('#ffe2a8', 2.6));
    lamp.position.set(16.3, P.h - 0.9, z);
    scene.add(lamp);
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(16.3, P.h, z), new THREE.Vector3(16.3, P.h - 0.7, z)]), cableMat));
  }
  const kitchenLight = new THREE.PointLight('#fff1d6', 30, 20, 1.8); // kept low: with the sky also lighting the scene, a bright lamp washes the kitchen out
  kitchenLight.position.set(16, P.h - 1, 3);
  scene.add(kitchenLight);
  const kitchenSign = neonSign('KITCHEN', '#6fe3d2', 0.9);
  kitchenSign.rotation.y = -Math.PI / 2;
  kitchenSign.position.set(P.x1 - 0.2, P.h + 0.75, 3);
  scene.add(kitchenSign);

  // --- This is not a workspace: a safety board counting minutes without work talk, and a few signs.
  const workSign = new WorkSign(5.4, 3.3);
  workSign.group.position.set(-22.8, 3.1, SCREEN.z + 0.2);
  scene.add(workSign.group);
  for (const dx of [-2, 2]) scene.add(box(0.3, 3.1, 0.3, '#2a2230', -22.8 + dx, 1.55, SCREEN.z - 0.1));
  const jokes: [string, string, number, number, number, number][] = [
    ['OUT OF OFFICE', '#ff7ac8', 0.8, -NEWS_WALL.x, NEWS_WALL.y + NEWS_WALL.h / 2 + 0.85, SCREEN.z + 0.25],
    ['404: WORK NOT FOUND', '#8fd7ff', 0.8, NEWS_WALL.x, NEWS_WALL.y + NEWS_WALL.h / 2 + 0.85, SCREEN.z + 0.25],
    ['CTRL + ALT + RELAX', '#ffd166', 0.75, (P.x1 + P.x2) / 2, P.h + 0.75, P.z2 + 0.25],
  ];
  for (const [text, color, size, x, y, z] of jokes) {
    const sign = neonSign(text, color, size);
    sign.position.set(x, y, z);
    scene.add(sign);
  }

  // --- Plants
  PLANTS.forEach((p, i) => {
    const standIn = plant(p.x, p.z, p.scale);
    scene.add(standIn);
    furnish(scene, 'pottedPlant', { x: p.x, z: p.z, ry: i * 1.9, w: 1.0 * p.scale, h: 2.3 * p.scale, d: 1.1 * p.scale, tint: { wood: '#b0603f', woodDark: '#8a4a30' } }, [standIn]);
  });

  const loungeSign = textSprite('Sit by the fire to talk face to face', 0.4);
  loungeSign.position.set(LOUNGE.x, 3.4, LOUNGE.z);
  scene.add(loungeSign);

  return {
    scene,
    setBoard: (board) => billboard.setBoard(board),
    setWork: (at, by) => workSign.set(at, by),
    screenFrames: () => screenTex?.version ?? 0,
    setScreenVideo(el) {
      screenTex?.dispose();
      screenTex = null;
      screenEl = el;
      screenAspect = 0;
      screenTime = -1;
      if (el) {
        screenTex = new THREE.VideoTexture(el);
        screenTex.colorSpace = THREE.SRGBColorSpace;
        screenMat.map = screenTex;
      } else {
        screenMat.map = idle;
        screen.scale.set(SCREEN.w, SCREEN.h, 1);
      }
      screenMat.needsUpdate = true;
      screenGlow.intensity = el ? 60 : 0;
    },
    update(time, dt) {
      // Letterbox the shared video inside the screen once its size is known.
      if (screenEl && screenEl.videoWidth && screenEl.videoHeight) {
        const a = screenEl.videoWidth / screenEl.videoHeight;
        if (a !== screenAspect) {
          screenAspect = a;
          const fit = SCREEN.w / SCREEN.h;
          if (a >= fit) screen.scale.set(SCREEN.w, SCREEN.w / a, 1);
          else screen.scale.set(SCREEN.h * a, SCREEN.h, 1);
        }
      }
      // Copy each new video frame to the screen ourselves. The 3D library waits for the browser to
      // announce frames, which it stops doing for a video that isn't shown on the page itself.
      if (screenTex && screenEl && screenEl.readyState >= 2 && screenEl.currentTime !== screenTime) {
        screenTime = screenEl.currentTime;
        screenTex.needsUpdate = true;
      }
      billboard.update(time);
      workSign.update();
      city.update(time);
      for (const b of bulbs) b.scale.setScalar(1 + Math.sin(time * 2 + b.userData.phase) * 0.18);

      // Fire: flames lick, sparks rise, the light flickers.
      for (const f of flames) {
        const p = f.userData.phase;
        f.scale.set(1 + Math.sin(time * 9 + p) * 0.15, 1 + Math.sin(time * 7 + p * 2) * 0.28, 1 + Math.cos(time * 8 + p) * 0.15);
        f.rotation.y = time * 1.5 + p;
      }
      sparkSeed.forEach((sp, i) => {
        sp.t = (sp.t + dt * sp.speed * 0.35) % 1;
        const drift = sp.r * (1 - sp.t * 0.5);
        sparkPos[i * 3] = LOUNGE.x + Math.cos(sp.a + sp.t * 2) * drift;
        sparkPos[i * 3 + 1] = 0.8 + sp.t * 3.4;
        sparkPos[i * 3 + 2] = LOUNGE.z + Math.sin(sp.a + sp.t * 2) * drift;
      });
      sparkGeo.attributes.position.needsUpdate = true;
      fireLight.intensity = 120 + Math.sin(time * 9) * 12 + Math.sin(time * 17) * 8;
    },
  };
}
