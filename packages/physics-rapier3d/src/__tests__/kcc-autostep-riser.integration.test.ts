import { createWorldContext, FixedUpdate, World } from '@forgeax/engine-ecs';
import { vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld } from '@forgeax/engine-physics';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
  registerPhysicsComponents,
} from '@forgeax/engine-physics';
import { GlobalTransform, Transform } from '@forgeax/engine-scene';
import type { SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerPhysicsSystems } from '../physics-sync.js';
import { createRapier3DPhysicsWorld } from '../rapier-physics-world-3d.js';
import { loadRapier3D } from '../wasm-loader.js';

// Terrain lab geometry: slab stairs with 0.5 m risers (= autoStepMaxHeight) at x -1.5..-0.5, and a 3/8 then 5/8 step at x 3.
const ORIGIN = 0.5 + 0.55 + 0.38 + 0.03;
const SPEED = 5.5,
  GRAVITY = 17,
  DT = 1 / 60;

async function fixture() {
  const terrain: Record<string, SceneEntity> = {
    'collision/0': {
      components: {
        Transform: { pos: [-0.5, 0, -0.5] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [12, 0.5, 12], friction: 0.86, restitution: 0 },
      },
    },
    'collision/1': {
      components: {
        Transform: { pos: [5.625, 0.5625, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.0625, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/2': {
      components: {
        Transform: { pos: [5.875, 0.625, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.125, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/3': {
      components: {
        Transform: { pos: [6.125, 0.6875, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.1875, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/4': {
      components: {
        Transform: { pos: [6.375, 0.75, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.25, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/5': {
      components: {
        Transform: { pos: [6.625, 0.8125, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.3125, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/6': {
      components: {
        Transform: { pos: [6.875, 0.875, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.375, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/7': {
      components: {
        Transform: { pos: [7.125, 0.9375, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.125, 0.4375, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/8': {
      components: {
        Transform: { pos: [7.875, 1, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [0.625, 0.5, 4.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/9': {
      components: {
        Transform: { pos: [-5, 0.5625, -4.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/10': {
      components: {
        Transform: { pos: [-5, 0.625, -4.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/11': {
      components: {
        Transform: { pos: [-5, 0.6875, -3.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/12': {
      components: {
        Transform: { pos: [-5, 0.75, -3.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/13': {
      components: {
        Transform: { pos: [-5, 0.8125, -3.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/14': {
      components: {
        Transform: { pos: [-1, 0.75, -3] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/15': {
      components: {
        Transform: { pos: [-5, 0.875, -3.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/16': {
      components: {
        Transform: { pos: [-5, 0.9375, -2.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/17': {
      components: {
        Transform: { pos: [-5, 1, -1.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 1.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/18': {
      components: {
        Transform: { pos: [-1, 1, -2] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/19': {
      components: {
        Transform: { pos: [-9, 0.5625, -1.4375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/20': {
      components: {
        Transform: { pos: [-1, 1.25, -1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.75, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/21': {
      components: {
        Transform: { pos: [-9, 0.625, -1.3125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/22': {
      components: {
        Transform: { pos: [-9, 0.6875, -1.1875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/23': {
      components: {
        Transform: { pos: [-9, 0.75, -1.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/24': {
      components: {
        Transform: { pos: [-9, 0.8125, -0.9375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/25': {
      components: {
        Transform: { pos: [-9, 0.875, -0.8125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/26': {
      components: {
        Transform: { pos: [-9, 0.9375, -0.6875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/27': {
      components: {
        Transform: { pos: [-9, 1, -0.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.5625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/28': {
      components: {
        Transform: { pos: [-5, 1.5, 0] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 1, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/29': {
      components: {
        Transform: { pos: [-1, 1.5, 0] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 1, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/30': {
      components: {
        Transform: { pos: [3, 0.8125, 0] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/31': {
      components: {
        Transform: { pos: [-9, 1.5, 1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 1, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/32': {
      components: {
        Transform: { pos: [-5, 1, 1.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 1.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/33': {
      components: {
        Transform: { pos: [-1, 1.25, 1] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.75, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/34': {
      components: {
        Transform: { pos: [-9, 1, 2.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.5625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/35': {
      components: {
        Transform: { pos: [-1, 1, 2] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/36': {
      components: {
        Transform: { pos: [-1, 0.75, 3] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/37': {
      components: {
        Transform: { pos: [3, 0.6875, 3] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.5], friction: 0.86, restitution: 0 },
      },
    },
    'collision/38': {
      components: {
        Transform: { pos: [-9, 0.9375, 2.6875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/39': {
      components: {
        Transform: { pos: [-9, 0.875, 2.8125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/40': {
      components: {
        Transform: { pos: [-5, 0.9375, 2.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/41': {
      components: {
        Transform: { pos: [-9, 0.8125, 2.9375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/42': {
      components: {
        Transform: { pos: [-9, 0.75, 3.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/43': {
      components: {
        Transform: { pos: [-5, 0.875, 3.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/44': {
      components: {
        Transform: { pos: [-9, 0.6875, 3.1875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/45': {
      components: {
        Transform: { pos: [-9, 0.625, 3.3125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/46': {
      components: {
        Transform: { pos: [-5, 0.8125, 3.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/47': {
      components: {
        Transform: { pos: [-9, 0.5625, 3.4375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/48': {
      components: {
        Transform: { pos: [-5, 0.75, 3.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/49': {
      components: {
        Transform: { pos: [-5, 0.6875, 3.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/50': {
      components: {
        Transform: { pos: [-5, 0.625, 4.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/51': {
      components: {
        Transform: { pos: [-5, 0.5625, 4.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/52': {
      components: {
        Transform: { pos: [-5, 1.5625, -2.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/53': {
      components: {
        Transform: { pos: [-5, 1.625, -2.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/54': {
      components: {
        Transform: { pos: [-5, 1.6875, -1.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/55': {
      components: {
        Transform: { pos: [-5, 1.75, -1.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/56': {
      components: {
        Transform: { pos: [-5, 1.8125, -1.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/57': {
      components: {
        Transform: { pos: [-5, 1.875, -1.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/58': {
      components: {
        Transform: { pos: [-5, 1.9375, -0.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/59': {
      components: {
        Transform: { pos: [-5, 2, -0.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/60': {
      components: {
        Transform: { pos: [-9, 1.5625, -0.4375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/61': {
      components: {
        Transform: { pos: [-9, 1.625, -0.3125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/62': {
      components: {
        Transform: { pos: [-9, 1.6875, -0.1875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/63': {
      components: {
        Transform: { pos: [-9, 1.75, -0.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/64': {
      components: {
        Transform: { pos: [-9, 1.8125, 0.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/65': {
      components: {
        Transform: { pos: [-9, 1.875, 0.1875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/66': {
      components: {
        Transform: { pos: [-9, 1.9375, 0.3125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/67': {
      components: {
        Transform: { pos: [-9, 2, 0.4375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/68': {
      components: {
        Transform: { pos: [-5, 2, 0.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/69': {
      components: {
        Transform: { pos: [-5, 1.9375, 0.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/70': {
      components: {
        Transform: { pos: [-5, 1.875, 1.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/71': {
      components: {
        Transform: { pos: [-5, 1.8125, 1.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/72': {
      components: {
        Transform: { pos: [-9, 2, 1.5625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.5, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/73': {
      components: {
        Transform: { pos: [-5, 1.75, 1.625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/74': {
      components: {
        Transform: { pos: [-9, 1.9375, 1.6875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.4375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/75': {
      components: {
        Transform: { pos: [-9, 1.875, 1.8125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.375, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/76': {
      components: {
        Transform: { pos: [-5, 1.6875, 1.875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/77': {
      components: {
        Transform: { pos: [-9, 1.8125, 1.9375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.3125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/78': {
      components: {
        Transform: { pos: [-9, 1.75, 2.0625] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.25, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/79': {
      components: {
        Transform: { pos: [-5, 1.625, 2.125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/80': {
      components: {
        Transform: { pos: [-9, 1.6875, 2.1875] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.1875, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/81': {
      components: {
        Transform: { pos: [-9, 1.625, 2.3125] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.125, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
    'collision/82': {
      components: {
        Transform: { pos: [-5, 1.5625, 2.375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.125], friction: 0.86, restitution: 0 },
      },
    },
    'collision/83': {
      components: {
        Transform: { pos: [-9, 1.5625, 2.4375] },
        RigidBody: { type: 0 },
        Collider: { shape: 0, halfExtents: [1.5, 0.0625, 0.0625], friction: 0.86, restitution: 0 },
      },
    },
  };
  const character: SceneEntity = {
    components: {
      Transform: { pos: [0, ORIGIN, 7] },
      RigidBody: { type: RigidBodyTypeValue.kinematic },
      Collider: {
        shape: ColliderShapeValue.capsule,
        radius: 0.38,
        halfHeight: 0.55,
        friction: 0.7,
        restitution: 0,
      },
      CharacterController: {
        offset: 0.03,
        maxSlopeClimbDeg: 52,
        minSlopeSlideDeg: 55,
        autoStepMaxHeight: 0.5,
        autoStepMinWidth: 0.2,
        snapToGroundDist: 0.24,
      },
    },
  };
  const asset: SceneAsset = { kind: 'scene', entities: { character, ...terrain } };
  const world = new World();
  const ctx = await createWorldContext(world);
  world.components.register(Transform).unwrap();
  world.components.register(GlobalTransform).unwrap();
  registerPhysicsComponents(world);
  const physics = createRapier3DPhysicsWorld(await loadRapier3D());
  world.insertResource('PhysicsWorld', physics);
  registerPhysicsSystems(world);
  let entity = 0;
  for (const [key, value] of Object.entries(asset.entities)) {
    const tokens = { Transform, RigidBody, Collider, CharacterController };
    const components = Object.entries(value.components ?? {}).map(([name, data]) => ({
      component: tokens[name as keyof typeof tokens],
      data,
    }));
    const handle = world.spawn(...(components as never[])).unwrap();
    if (key === 'character') entity = handle;
  }
  let start: [number, number] | undefined,
    verticalVelocity = 0;
  // Same per-tick move as a walking character: one moveAndSlide toward -Z with gravity, between sync and step.
  world.addSystem(FixedUpdate, {
    name: 'kcc-riser-walk',
    after: ['physicsSyncBackend'],
    before: ['physicsStepSimulation'],
    queries: [],
    fn: () => {
      const pw = world.getResource<PhysicsWorld>('PhysicsWorld');
      if (!pw.hasBody(entity)) return;
      if (start) {
        pw.teleport(entity, vec3.create(start[0], ORIGIN, start[1]));
        start = undefined;
        verticalVelocity = 0;
        return;
      }
      const grounded = world.get(entity as never, CharacterController).unwrap().grounded === true;
      verticalVelocity =
        grounded && verticalVelocity <= 0 ? -GRAVITY * DT : verticalVelocity - GRAVITY * DT;
      pw.moveAndSlide(entity, vec3.create(0, verticalVelocity * DT, -SPEED * DT));
      if (
        world.get(entity as never, CharacterController).unwrap().grounded === true &&
        verticalVelocity < 0
      )
        verticalVelocity = 0;
    },
  });
  const tick = () => world.update(DT).unwrap();
  const position = () =>
    [...world.get(entity as never, Transform).unwrap().pos] as [number, number, number];
  /** Walk from (x, z) toward -Z until z <= -6 or `ticks`; feet height is reported in map units. */
  const walk = (x: number, z: number, ticks = 300) => {
    start = [x, z];
    tick();
    tick();
    let maxY = 0;
    for (let i = 0; i < ticks && position()[2] > -6; i++) {
      tick();
      maxY = Math.max(maxY, position()[1] - ORIGIN + 0.5);
    }
    return { end: position(), maxY };
  };
  return {
    walk,
    tick,
    position,
    dispose: async () => {
      await ctx.fiber.dispose();
      world.despawnAll().unwrap();
      physics.dispose();
    },
  };
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
afterAll(async () => {
  await f?.dispose();
});

it('climbs every 0.5 m riser of the slab stairs from 1005 approaches', () => {
  // Unpatched, about 1% of these walks stop for good at z 0.91: radius 0.38 + offset 0.03 in front of the riser at z 0.5.
  const stalled: string[] = [];
  for (const z of [7, 6.99, 6.97, 6.955, 6.94])
    for (let i = 0; i <= 200; i++) {
      const x = -1.5 + i * 0.005;
      const run = f.walk(x, z);
      if (run.end[2] > -6 || Math.abs(run.maxY - 2.5) > 0.05)
        stalled.push(`x=${x.toFixed(3)} z=${z} at ${run.end[2].toFixed(2)}`);
    }
  expect(stalled).toEqual([]);
}, 120_000);

it('still stops at a 5/8 m step and does not creep while pushing into it', () => {
  const run = f.walk(3, 7, 180);
  expect(run.maxY).toBeCloseTo(0.875, 1);
  expect(run.end[2]).toBeCloseTo(0.91, 2);
  for (let i = 0; i < 180; i++) f.tick();
  const pushed = f.position();
  expect(pushed[1]).toBeCloseTo(run.end[1], 2);
  expect(pushed[2]).toBeCloseTo(run.end[2], 4);
});
