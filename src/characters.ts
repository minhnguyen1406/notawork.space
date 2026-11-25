import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { NPC_ID } from '../shared/fun';

// Animated people from Kenney's "Mini Characters" pack (CC0). See ASSETS.md.
const PEOPLE = ['male-a', 'female-a', 'male-b', 'female-b', 'male-c', 'female-c', 'male-d', 'female-d', 'male-e', 'female-e', 'male-f', 'female-f', 'male-g'];
/** How tall a character stands in the room, in metres (the models themselves are tiny). */
const HEIGHT = 2.2;

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Which model someone gets. It follows their name, so you look the same every time you come in. */
export const characterFor = (id: string, name: string) => (id === NPC_ID ? 'robot' : PEOPLE[hash(name.trim().toLowerCase()) % PEOPLE.length]);

export interface Character {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Start (or keep) playing a named animation, blending from whatever was playing. */
  play(name: string, speed?: number): void;
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[]; scale: number }>>();

function load(kind: string) {
  let p = cache.get(kind);
  if (!p) {
    p = loader.loadAsync(`${import.meta.env.BASE_URL}characters/${kind}.glb`).then((gltf) => {
      const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          o.frustumCulled = false; // animated limbs move outside the resting bounds
        }
      });
      return { scene: gltf.scene, clips: gltf.animations, scale: HEIGHT / (size.y || 1) };
    });
    cache.set(kind, p);
  }
  return p;
}

/** A fresh, independently animated copy of a character model. Rejects if the file can't be fetched. */
export async function makeCharacter(kind: string): Promise<Character> {
  const { scene, clips, scale } = await load(kind);
  const root = cloneSkinned(scene);
  root.scale.setScalar(scale);
  root.userData.shared = true; // geometry and materials belong to every copy: never dispose them
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map(clips.map((c) => [c.name, mixer.clipAction(c)]));
  let current: THREE.AnimationAction | null = null;
  return {
    root,
    mixer,
    play(name, speed = 1) {
      const next = actions.get(name) ?? actions.get('idle');
      if (!next) return;
      next.timeScale = speed;
      if (next === current) return;
      next.reset().fadeIn(0.18).play();
      current?.fadeOut(0.18);
      current = next;
    },
  };
}
