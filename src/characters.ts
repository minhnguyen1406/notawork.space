import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LOOKS } from '../shared/protocol';

// Animated people from Kenney's "Mini Characters" pack (CC0). See ASSETS.md.
/** How tall a character stands in the room, in metres (the models themselves are tiny). */
const HEIGHT = 2.2;

/** The model file for someone's chosen character, falling back to the first if the choice is unknown. */
export const characterFor = (look: string) => (look === 'robot' || LOOKS.includes(look) ? look : LOOKS[0]);

export interface Character {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Start (or keep) playing a named animation, blending from whatever was playing. */
  play(name: string, speed?: number, once?: boolean): void;
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
    play(name, speed = 1, once = false) {
      const next = actions.get(name) ?? actions.get('idle');
      if (!next) return;
      next.timeScale = speed;
      if (next === current) return;
      // "Once" animations (falling over) play through and hold their last pose.
      next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.reset().fadeIn(0.18).play();
      current?.fadeOut(0.18);
      current = next;
    },
  };
}
