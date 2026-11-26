import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Furniture from Kenney's "Furniture Kit" (CC0). See ASSETS.md.
//
// Each piece is drawn first as plain boxes (the stand-in). When its model arrives the stand-in is
// made invisible, but it stays in the scene: what blocks walking is worked out from the stand-ins
// (see collide.ts), and the models themselves are marked walk-through, so the room is exactly as
// solid with the models as without them, whenever they happen to load.

/**
 * The kit is flat-coloured and rather bright. These are the colours its named materials get here,
 * chosen to sit with the room's warm evening palette. A placement can override any of them.
 */
const PALETTE: Record<string, string> = {
  wood: '#b08556',
  woodDark: '#7a5236',
  carpet: '#b0483f',
  carpetDarker: '#7d2c38',
  carpetBlue: '#5a6a9f',
  carpetWhite: '#efe8da',
  metal: '#cfc8c0',
  metalLight: '#e9e2d6',
  metalMedium: '#6a6470',
  metalDark: '#3a3438',
  glass: '#8fa39c',
  plant: '#4f8f47',
  lamp: '#ffd9a0',
  _defaultMat: '#efe8da',
};

/** Material names that glow rather than being lit. */
const GLOWS = new Set(['lamp']);

const loader = new GLTFLoader();
interface Model {
  scene: THREE.Object3D;
  min: THREE.Vector3;
  size: THREE.Vector3;
}
const cache = new Map<string, Promise<Model>>();

function load(name: string) {
  let p = cache.get(name);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}furniture/${name}.glb`).then((gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      return { scene: gltf.scene, min: box.min.clone(), size: box.getSize(new THREE.Vector3()) };
    });
    cache.set(name, p);
  }
  return p;
}

const materials = new Map<string, THREE.Material>();
function material(name: string, color: string) {
  const key = `${name}|${color}`;
  let m = materials.get(key);
  if (!m) {
    m = GLOWS.has(name)
      ? new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.6) })
      : new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 });
    m.name = name;
    materials.set(key, m);
  }
  return m;
}

/** Drawn by nothing, but still a visible mesh as far as collisions are concerned. */
const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });

function hide(standIn: THREE.Object3D) {
  standIn.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.material = HIDDEN;
    o.castShadow = false;
    o.receiveShadow = false;
  });
}

export interface Placement {
  /** Where the middle of the piece's footprint stands, in the parent's space. */
  x?: number;
  /** Height of its underside. */
  y?: number;
  z?: number;
  /** Facing, the same way as a seat's: 0 faces +z. */
  ry?: number;
  /**
   * Size in metres: width, height and depth in the piece's own axes (before turning). Leave one
   * out and it keeps its proportion to the ones given.
   */
  w?: number;
  h?: number;
  d?: number;
  /** Metres to move it backwards, away from the way it faces (so a seat cushion lands under the sitter). */
  back?: number;
  /** Colours for the kit's named materials, over the palette above. */
  tint?: Record<string, string>;
}

/**
 * Put a furniture model in `parent`. The stand-ins stay as they are until the model has loaded,
 * then turn invisible (still there for collisions); if it can't be fetched they simply stay.
 */
export function furnish(parent: THREE.Object3D, name: string, at: Placement, standIns: THREE.Object3D[] = []) {
  load(name).then(
    ({ scene, min, size }) => {
      const ratios = [at.w && at.w / size.x, at.h && at.h / size.y, at.d && at.d / size.z];
      const given = ratios.filter((r): r is number => !!r);
      const rest = given.length ? given.reduce((a, b) => a + b, 0) / given.length : 1;
      const [sx, sy, sz] = ratios.map((r) => r || rest);

      const holder = new THREE.Group();
      holder.name = `furniture:${name}`;
      holder.userData.walkThrough = true;
      holder.userData.shared = true; // geometry and materials belong to every copy: never dispose them
      const ry = at.ry ?? 0;
      const back = at.back ?? 0;
      holder.position.set((at.x ?? 0) - Math.sin(ry) * back, at.y ?? 0, (at.z ?? 0) - Math.cos(ry) * back);
      holder.rotation.y = ry;
      holder.scale.set(sx, sy, sz);

      const copy = scene.clone(true);
      // The kit puts each model's origin at a corner: stand it on the floor, centred.
      copy.position.set(-(min.x + size.x / 2), -min.y, -(min.z + size.z / 2));
      copy.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const kind = (o.material as THREE.Material).name;
        const glows = GLOWS.has(kind);
        o.material = material(kind, at.tint?.[kind] ?? PALETTE[kind] ?? '#b08556');
        o.castShadow = !glows;
        o.receiveShadow = !glows;
      });
      holder.add(copy);
      parent.add(holder);
      for (const s of standIns) hide(s);
    },
    () => {
      // Couldn't fetch the model: the boxes stay.
    },
  );
}
