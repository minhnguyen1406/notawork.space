import * as THREE from 'three';
import { DINING, STATIONS, type Station } from '../shared/layout';
import {
  CHOPPABLE,
  COOK_MS,
  ING_LABEL,
  plateState,
  type IngState,
  type IngType,
  type Item,
  type KitchenState,
} from '../shared/kitchen';
import { box, mat } from './world';
import { textSprite, type Avatar } from './avatar';

const mesh = (geo: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
};

/** A small model for one ingredient in a given state. Sits on y = 0. */
function ingMesh(type: IngType, st: IngState): THREE.Object3D {
  const g = new THREE.Group();
  switch (type) {
    case 'tomato':
      if (st === 'chopped') {
        for (let i = 0; i < 3; i++) g.add(mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 10), '#d8392b', (i - 1) * 0.13, 0.03 + i * 0.012, (i % 2) * 0.08));
      } else {
        g.add(mesh(new THREE.SphereGeometry(0.2, 10, 8), '#d8392b', 0, 0.2, 0));
        g.add(mesh(new THREE.ConeGeometry(0.07, 0.07, 5), '#3f8a3a', 0, 0.41, 0));
      }
      break;
    case 'lettuce':
      if (st === 'chopped') {
        for (let i = 0; i < 4; i++) {
          const leaf = mesh(new THREE.BoxGeometry(0.2, 0.03, 0.15), i % 2 ? '#7cc45a' : '#5fae48', (i % 2) * 0.16 - 0.08, 0.02 + i * 0.022, (i > 1 ? 1 : -1) * 0.07);
          leaf.rotation.y = i * 0.7;
          g.add(leaf);
        }
      } else {
        g.add(mesh(new THREE.IcosahedronGeometry(0.24, 0), '#6cbb50', 0, 0.22, 0));
      }
      break;
    case 'bun': {
      const b = mesh(new THREE.SphereGeometry(0.25, 10, 8), '#d9a15b', 0, 0.1, 0);
      b.scale.y = 0.5;
      g.add(b);
      break;
    }
    case 'cheese':
      g.add(mesh(new THREE.BoxGeometry(0.34, 0.05, 0.34), '#f6c443', 0, 0.03, 0));
      break;
    case 'patty':
      g.add(mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.09, 12), st === 'cooked' ? '#6b3f2a' : '#d98a8a', 0, 0.045, 0));
      break;
    case 'egg':
      if (st === 'cooked') {
        g.add(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 12), '#fbf6ea', 0, 0.015, 0));
        const yolk = mesh(new THREE.SphereGeometry(0.09, 8, 6), '#f3a712', 0, 0.035, 0);
        yolk.scale.y = 0.6;
        g.add(yolk);
      } else {
        const e = mesh(new THREE.SphereGeometry(0.14, 8, 8), '#f4ead6', 0, 0.17, 0);
        e.scale.y = 1.25;
        g.add(e);
      }
      break;
  }
  return g;
}

const STACK_H: Record<IngType, number> = { tomato: 0.06, lettuce: 0.07, bun: 0.2, cheese: 0.05, patty: 0.09, egg: 0.06 };

export function itemMesh(item: Item): THREE.Object3D {
  if (item.k === 'ing') return ingMesh(item.type, item.st);
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.36, 0.28, 0.05, 16), '#f7f4ee', 0, 0.025, 0));
  let y = 0.05;
  // Bun at the bottom, the rest stacked on top.
  const order = [...item.c].sort((a, b) => (a === 'bun' ? -1 : b === 'bun' ? 1 : 0));
  for (const type of order) {
    const m = ingMesh(type, plateState(type));
    m.position.y = y;
    g.add(m);
    y += STACK_H[type];
  }
  return g;
}

function clear(group: THREE.Object3D) {
  for (const child of [...group.children]) {
    child.removeFromParent();
    child.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }
}

interface StationView {
  st: Station;
  slot: THREE.Group;
  bar: THREE.Group | null;
  fill: THREE.Mesh | null;
  burner: THREE.MeshBasicMaterial | null;
}

/** Draws the kitchen from the state the server sends. It never decides anything itself. */
export class KitchenView {
  state: KitchenState | null = null;
  private views = new Map<string, StationView>();
  private table = new THREE.Group();
  private clockOffset = 0;

  constructor(scene: THREE.Scene) {
    for (const st of STATIONS) scene.add(this.buildStation(st));
    this.table.position.set(DINING.x, 0.96, DINING.z);
    scene.add(this.table);
  }

  private buildStation(st: Station): THREE.Group {
    const g = new THREE.Group();
    g.position.set(st.x, 0, st.z);
    const slot = new THREE.Group();
    slot.position.y = 1.09;
    g.add(slot);
    const view: StationView = { st, slot, bar: null, fill: null, burner: null };
    this.views.set(st.id, view);

    const label = (text: string, y = 1.7) => {
      const s = textSprite(text, 0.36);
      s.position.y = y;
      g.add(s);
    };

    if (st.type === 'bin') {
      g.add(mesh(new THREE.CylinderGeometry(0.62, 0.5, 1.1, 10), '#3f5a4a', 0, 0.55, 0));
      g.add(mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.08, 10), '#2c4035', 0, 1.12, 0));
      label('Bin');
      return g;
    }

    if (st.type === 'crate') {
      g.add(box(1.6, 0.9, 1.6, '#b98b56', 0, 0.45, 0));
      g.add(box(1.7, 0.12, 1.7, '#8f6a3f', 0, 0.94, 0));
      for (const [dx, dz] of [[-0.3, -0.25], [0.3, -0.2], [0, 0.3]] as const) {
        const m = ingMesh(st.ing!, 'raw');
        m.position.set(dx, 1.0, dz);
        m.scale.setScalar(1.25);
        g.add(m);
      }
      label(ING_LABEL[st.ing!][0].toUpperCase() + ING_LABEL[st.ing!].slice(1));
      return g;
    }

    // Everything else is a counter with something on top.
    g.add(box(1.6, 0.96, 1.6, '#a9794f', 0, 0.48, 0));
    g.add(box(1.72, 0.1, 1.72, '#efe8da', 0, 1.02, 0));

    if (st.type === 'board') {
      g.add(box(1.0, 0.05, 0.7, '#d7b58a', 0, 1.095, 0));
      slot.position.y = 1.12;
      // A little knife beside the board
      g.add(box(0.06, 0.02, 0.34, '#d0d4da', 0.66, 1.09, -0.08));
      g.add(box(0.07, 0.04, 0.18, '#3a2a22', 0.66, 1.09, 0.2));
    }
    if (st.type === 'stove') {
      g.add(box(1.5, 0.06, 1.5, '#2b2b30', 0, 1.1, 0));
      const burner = new THREE.MeshBasicMaterial({ color: '#40302c', toneMapped: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.05, 6, 20), burner);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.15;
      g.add(ring);
      g.add(mesh(new THREE.CylinderGeometry(0.42, 0.36, 0.08, 14), '#55565e', 0, 1.2, 0));
      g.add(box(0.1, 0.05, 0.5, '#3a2a22', 0, 1.22, 0.64));
      slot.position.y = 1.24;
      view.burner = burner;
    }
    if (st.type === 'plates') {
      for (let i = 0; i < 5; i++) g.add(mesh(new THREE.CylinderGeometry(0.36, 0.28, 0.05, 16), '#f7f4ee', 0, 1.1 + i * 0.055, 0));
      label('Plates');
    }
    if (st.type === 'hatch') {
      g.add(box(0.14, 1.5, 0.14, '#6f4a32', -0.78, 1.8, 0));
      g.add(box(0.14, 1.5, 0.14, '#6f4a32', 0.78, 1.8, 0));
      g.add(box(1.9, 0.3, 0.5, '#b5474b', 0, 2.65, 0));
      const bell = mesh(new THREE.SphereGeometry(0.16, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#e9b949', 0.5, 1.07, 0.45);
      g.add(bell);
      label('Serve here', 3.25);
    }

    if (st.type === 'board' || st.type === 'stove') {
      const bar = new THREE.Group();
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.14), new THREE.MeshBasicMaterial({ color: '#1b1620' }));
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(0.94, 0.09),
        new THREE.MeshBasicMaterial({ color: '#9be564', toneMapped: false }),
      );
      fill.position.z = 0.005;
      bar.add(back, fill);
      bar.position.y = 2.0;
      bar.visible = false;
      g.add(bar);
      view.bar = bar;
      view.fill = fill;
    }
    return g;
  }

  /** Server time, estimated from the last state message. */
  now() {
    return Date.now() + this.clockOffset;
  }

  setState(state: KitchenState, avatars: Map<string, Avatar>) {
    this.state = state;
    this.clockOffset = state.now - Date.now();
    for (const v of this.views.values()) this.drawSlot(v);
    this.drawHeld(avatars);
    clear(this.table);
    state.served.forEach((c, i) => {
      const m = itemMesh({ k: 'plate', c });
      m.position.set(i % 2 ? 0.35 : -0.35, 0, -2.2 + i * 0.88);
      this.table.add(m);
    });
  }

  private drawSlot(v: StationView) {
    clear(v.slot);
    const item = this.state?.slots[v.st.id];
    if (item) v.slot.add(itemMesh(item));
  }

  drawHeld(avatars: Map<string, Avatar>) {
    for (const [id, a] of avatars) {
      clear(a.hold);
      const item = this.state?.held[id];
      if (item) a.hold.add(itemMesh(item));
    }
  }

  update(camera: THREE.Camera) {
    if (!this.state) return;
    const now = this.now();
    for (const v of this.views.values()) {
      if (!v.bar || !v.fill) continue;
      const item = this.state.slots[v.st.id];
      let progress = -1;
      if (item && item.k === 'ing') {
        if (item.doneAt !== undefined) {
          progress = 1 - (item.doneAt - now) / COOK_MS;
          if (progress >= 1) {
            // Finished cooking: show it cooked without waiting for the next server message.
            item.st = 'cooked';
            delete item.doneAt;
            this.drawSlot(v);
            progress = -1;
          }
        } else if (item.st === 'raw' && item.prog && CHOPPABLE.includes(item.type)) {
          progress = item.prog;
        }
      }
      v.bar.visible = progress >= 0;
      if (progress >= 0) {
        const p = Math.max(0.02, Math.min(1, progress));
        v.fill.scale.x = p;
        v.fill.position.x = -(0.94 * (1 - p)) / 2;
        v.bar.quaternion.copy(camera.quaternion);
      }
      if (v.burner) v.burner.color.set(item && item.k === 'ing' && item.doneAt !== undefined ? '#ff7a2f' : '#40302c');
    }
  }
}
