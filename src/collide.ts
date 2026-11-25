import * as THREE from 'three';
import { BOUNDS, COLLIDERS, type Collider } from '../shared/layout';

/** Lower than this you step over it (pitch boards, kerbs). */
const STEP_OVER = 0.7;
/** Anything that starts above this is overhead (roofs, banners, signs on poles). */
const HEAD = 1.3;
/** Wider than this is the floor, a wall or the sky, not furniture. */
const TOO_BIG = 25;

/**
 * Work out what you can't walk through from the scenery itself, so that every chair, table,
 * counter and post blocks without having to be listed by hand. Call once, after the world is
 * built and before any people are added. Mark a mesh `userData.walkThrough = true` to skip it.
 */
export function sceneColliders(scene: THREE.Scene): Collider[] {
  scene.updateMatrixWorld(true);
  const out: Collider[] = [...COLLIDERS];
  const box = new THREE.Box3();
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.walkThrough) return;
    const m = o.material as THREE.Material;
    if (!Array.isArray(m) && m.transparent && m.opacity < 0.5) return; // glows, nets, light shafts
    box.setFromObject(o);
    if (box.isEmpty() || box.max.y < STEP_OVER || box.min.y > HEAD) return;
    const hw = (box.max.x - box.min.x) / 2;
    const hd = (box.max.z - box.min.z) / 2;
    if (hw * 2 > TOO_BIG || hd * 2 > TOO_BIG) return;
    const x = (box.min.x + box.max.x) / 2;
    const z = (box.min.z + box.max.z) / 2;
    if (x + hw < BOUNDS.x1 || x - hw > BOUNDS.x2 || z + hd < BOUNDS.z1 || z - hd > BOUNDS.z2) return;
    out.push({ x, z, hw, hd });
  });
  return out;
}

/** Red boxes over everything solid, for checking by eye in development. */
export function showColliders(scene: THREE.Scene, list: Collider[]) {
  const mat = new THREE.MeshBasicMaterial({ color: '#ff2a2a', transparent: true, opacity: 0.45, depthTest: false });
  const group = new THREE.Group();
  group.userData.walkThrough = true;
  for (const c of list) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(c.hw * 2, 0.05, c.hd * 2), mat);
    m.position.set(c.x, 1.5, c.z);
    m.renderOrder = 999;
    group.add(m);
  }
  scene.add(group);
}
