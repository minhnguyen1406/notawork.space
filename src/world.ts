import * as THREE from 'three';
import { ROOM_HALF } from '../shared/protocol';
import { DINING, LOUNGE, SCREEN, SEATS } from '../shared/layout';
import { textSprite } from './avatar';

export interface World {
  scene: THREE.Scene;
  /** Put a live video on the cinema screen, or pass null to go back to the idle card. */
  setScreenVideo(el: HTMLVideoElement | null): void;
  update(time: number): void;
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

export function buildWorld(): World {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#15121f');
  scene.fog = new THREE.Fog('#15121f', 42, 90);

  // --- Light: a warm evening indoors.
  scene.add(new THREE.HemisphereLight('#ffe9c9', '#3a2f4a', 1.15));
  const sun = new THREE.DirectionalLight('#ffd9a8', 1.5);
  sun.position.set(10, 26, 16);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -26;
  sc.right = sc.top = 26;
  sc.far = 70;
  scene.add(sun);

  // --- Shell: floor and inward-facing walls (invisible from outside, so the camera can orbit freely).
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat('#1c1826'));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const S = ROOM_HALF * 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), mat('#9a7653'));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  // Plank lines
  for (let i = -ROOM_HALF + 2; i < ROOM_HALF; i += 2) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(S, 0.04), mat('#7f5f42'));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.005, i);
    scene.add(line);
  }

  const WALL_H = 9;
  const wallGeo = new THREE.PlaneGeometry(S, WALL_H);
  const walls: [number, number, number][] = [
    [0, -ROOM_HALF, 0],
    [0, ROOM_HALF, Math.PI],
    [ROOM_HALF, 0, -Math.PI / 2],
    [-ROOM_HALF, 0, Math.PI / 2],
  ];
  for (const [x, z, ry] of walls) {
    const w = new THREE.Mesh(wallGeo, mat('#e2cfb2'));
    w.position.set(x, WALL_H / 2, z);
    w.rotation.y = ry;
    w.receiveShadow = true;
    scene.add(w);
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(S, 0.5), mat('#8a5a3c'));
    skirt.position.set(x * 0.999, 0.25, z * 0.999);
    skirt.rotation.y = ry;
    scene.add(skirt);
  }

  const rug = (geo: THREE.BufferGeometry, color: string, x: number, z: number, y = 0.012) => {
    const m = new THREE.Mesh(geo, mat(color));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };

  // --- Cinema (north)
  rug(new THREE.PlaneGeometry(19, 10), '#2f3a5f', 0, -8.5);
  rug(new THREE.PlaneGeometry(17.6, 8.6), '#3b4873', 0, -8.5, 0.016);
  const idle = idleScreenTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: idle, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), screenMat);
  screen.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.06);
  screen.scale.set(SCREEN.w, SCREEN.h, 1);
  scene.add(screen);
  const backing = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), new THREE.MeshBasicMaterial({ color: '#000' }));
  backing.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.04);
  scene.add(backing);
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w + 0.6, SCREEN.h + 0.6), mat('#3a2a22'));
  frame.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 0.02);
  scene.add(frame);
  const screenGlow = new THREE.PointLight('#8fa8ff', 0, 26, 1.6);
  screenGlow.position.set(SCREEN.x, SCREEN.y, SCREEN.z + 4);
  scene.add(screenGlow);

  let screenTex: THREE.VideoTexture | null = null;
  let screenEl: HTMLVideoElement | null = null;
  let screenAspect = 0;

  for (const seat of SEATS.filter((s) => s.group === 'cinema')) {
    const bag = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), mat(seat.id.endsWith('0') ? '#c96a4a' : '#d98b5f'));
    bag.scale.set(1, 0.5, 1);
    bag.position.set(seat.x, 0.3, seat.z);
    bag.castShadow = true;
    scene.add(bag);
  }

  // --- Lounge (south-west)
  rug(new THREE.CircleGeometry(5.6, 28), '#8e3239', LOUNGE.x, LOUNGE.z);
  rug(new THREE.CircleGeometry(4.9, 28), '#b5474b', LOUNGE.x, LOUNGE.z, 0.016);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.8, 0.5, 10), mat('#6f4a32'));
  table.position.set(LOUNGE.x, 0.25, LOUNGE.z);
  table.castShadow = true;
  scene.add(table);
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 10, 8),
    new THREE.MeshBasicMaterial({ color: '#ffcf8a', toneMapped: false }),
  );
  lamp.position.set(LOUNGE.x, 0.95, LOUNGE.z);
  scene.add(lamp);
  const lampLight = new THREE.PointLight('#ffb46b', 90, 22, 1.8);
  lampLight.position.set(LOUNGE.x, 1.6, LOUNGE.z);
  scene.add(lampLight);

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
  });

  // --- Dining table (by the kitchen)
  scene.add(box(1.8, 0.12, 5.8, '#7a5236', DINING.x, 0.9, DINING.z));
  for (const dx of [-0.7, 0.7])
    for (const dz of [-2.6, 2.6]) scene.add(box(0.16, 0.86, 0.16, '#5e3e29', DINING.x + dx, 0.43, DINING.z + dz));
  for (const seat of SEATS.filter((s) => s.group === 'dining')) {
    const chair = new THREE.Group();
    chair.add(box(0.8, 0.12, 0.8, '#c9a26b', 0, 0.5, 0));
    chair.add(box(0.8, 0.8, 0.1, '#c9a26b', 0, 0.9, -0.38));
    for (const dx of [-0.32, 0.32]) for (const dz of [-0.32, 0.32]) chair.add(box(0.08, 0.5, 0.08, '#8a6a44', dx, 0.25, dz));
    chair.position.set(seat.x, 0, seat.z);
    chair.rotation.y = seat.ry;
    scene.add(chair);
  }

  // --- Kitchen floor (east)
  rug(new THREE.PlaneGeometry(9.4, 17.6), '#d5dbd6', 15.3, 3);
  for (let i = 0; i < 9; i++)
    for (let j = 0; j < 5; j++)
      if ((i + j) % 2 === 0) rug(new THREE.PlaneGeometry(1.88, 1.955), '#bcc6c1', 11.54 + j * 1.88, -4.82 + i * 1.955, 0.016);
  const kitchenLight = new THREE.PointLight('#fff1d6', 70, 20, 1.8);
  kitchenLight.position.set(16, 5.5, 3);
  scene.add(kitchenLight);
  const kitchenSign = textSprite('KITCHEN', 0.8, { bg: 'rgba(36, 28, 43, 0.9)' });
  kitchenSign.position.set(16.3, 6.2, 3);
  scene.add(kitchenSign);

  // --- Decoration
  scene.add(plant(-18.4, -18.4, 1.5), plant(18.4, -18.4, 1.5), plant(-18.4, 18.4, 1.3), plant(18.4, 18.4, 1.3));
  scene.add(plant(-3.2, 17.6), plant(3.2, 17.6));

  // Bookshelf on the west wall
  const shelf = new THREE.Group();
  shelf.add(box(0.7, 4.2, 5, '#6f4a32', 0, 2.1, 0));
  const bookColors = ['#e4572e', '#f3a712', '#29a19c', '#3a86ff', '#8338ec', '#f2efe6', '#76b041'];
  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 12; i++) {
      const hgt = 0.55 + ((row * 7 + i * 3) % 5) * 0.05;
      shelf.add(box(0.5, hgt, 0.26, bookColors[(row * 5 + i) % bookColors.length], 0.14, 0.5 + row + hgt / 2, -2.1 + i * 0.36));
    }
    shelf.add(box(0.78, 0.08, 5, '#5e3e29', 0.02, 0.44 + row, 0));
  }
  shelf.position.set(-19.5, 0, -6);
  scene.add(shelf);

  // Framed pictures
  const pictures: [number, number, number, number, string][] = [
    [-19.9, 4.4, 14, Math.PI / 2, '#29a19c'],
    [-19.9, 4.8, 1.5, Math.PI / 2, '#f3a712'],
    [19.9, 5.6, -12, -Math.PI / 2, '#ff5d8f'],
    [-9, 4.6, 19.9, Math.PI, '#3a86ff'],
    [9, 4.6, 19.9, Math.PI, '#e4572e'],
  ];
  for (const [x, y, z, ry, color] of pictures) {
    const g = new THREE.Group();
    const f = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.2), mat('#3a2a22'));
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), mat(color));
    p.position.z = 0.01;
    const s = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), mat('#fff3d6'));
    s.position.set(0.6, 0.3, 0.02);
    g.add(f, p, s);
    g.position.set(x, y, z);
    g.rotation.y = ry;
    scene.add(g);
  }

  // String lights sagging across the room
  const bulbs: THREE.Mesh[] = [];
  const bulbColors = ['#ffd27a', '#ff8a6b', '#8fd3ff', '#b8f28a', '#ff9ad5'];
  const bulbGeo = new THREE.SphereGeometry(0.13, 6, 5);
  const spans: [number, number, number, number][] = [
    [-ROOM_HALF, -8, ROOM_HALF, -8],
    [-ROOM_HALF, 2, ROOM_HALF, 2],
    [-ROOM_HALF, 12, ROOM_HALF, 12],
    [-10, -ROOM_HALF, -10, ROOM_HALF],
    [10, -ROOM_HALF, 10, ROOM_HALF],
  ];
  for (const [x1, z1, x2, z2] of spans) {
    for (let i = 1; i < 24; i++) {
      const t = i / 24;
      const b = new THREE.Mesh(
        bulbGeo,
        new THREE.MeshBasicMaterial({ color: bulbColors[i % bulbColors.length], toneMapped: false }),
      );
      b.position.set(x1 + (x2 - x1) * t, 8.4 - Math.sin(t * Math.PI) * 1.5, z1 + (z2 - z1) * t);
      b.userData.phase = i * 0.7 + x1;
      bulbs.push(b);
      scene.add(b);
    }
  }

  return {
    scene,
    setScreenVideo(el) {
      screenTex?.dispose();
      screenTex = null;
      screenEl = el;
      screenAspect = 0;
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
    update(time) {
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
      for (const b of bulbs) b.scale.setScalar(1 + Math.sin(time * 2 + b.userData.phase) * 0.18);
      lampLight.intensity = 90 + Math.sin(time * 7) * 4 + Math.sin(time * 13) * 3;
    },
  };
}
