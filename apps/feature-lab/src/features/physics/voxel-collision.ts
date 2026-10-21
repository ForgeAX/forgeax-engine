import {
  type DerivedPhysicsCandidateInput,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import { Transform } from '@forgeax/engine/scene';
import { err } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { createPhysicsHarness3D, vec3 } from './support/rapier3d';

export default defineFeature({
  title: 'Voxel collision and editing',
  catalog: 'Voxel collision and editing',
  kind: 'headless',
  summary:
    'Compact occupied regions retain real holes. Prepare, cancel and publish replacement geometry through the same native physics transaction.',
  expect:
    'Native raycasts hit occupied cells and miss holes; preparation and cancellation retain the old body, refused publication rolls back, and an accepted edit updates collision and mass.',
  async run(checks) {
    const h = await createPhysicsHarness3D();
    if (typeof h === 'string') return void checks.ok('Rapier loads', false, h);
    try {
      h.physics.setGravity(vec3(0, 0, 0));
      const entity = h.spawn(
        { component: Transform, data: {} },
        { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
      );
      h.tick();
      const input = (revision: number, cut = false): DerivedPhysicsCandidateInput => ({
        entity,
        worldIdentity: h.world,
        sourceKey: 'lab-voxel-wall',
        revision,
        bodyType: 'dynamic',
        shapes: [
          {
            id: 'wall',
            revision,
            kind: 'voxels',
            regions: Int32Array.from(
              cut ? [1, 0, -1, 2, 1, 0] : [-2, 0, -1, -1, 1, 0, 1, 0, -1, 2, 1, 0],
            ),
            voxelSize: [1, 1, 1],
          },
        ],
        massProperties: { mode: 'automatic', density: 7 },
      });
      const hit = (x: number) => h.physics.raycast(vec3(x, -1, -0.5), vec3(0, 1, 0), 4)?.entity;
      const first = h.physics.prepareDerivedShapeCandidate(input(1)).unwrap();
      h.physics.admitDerivedShapeCandidate(first).unwrap();
      h.tick();
      checks.equal('occupied cell blocks the native ray', hit(-1.5), entity);
      checks.equal('empty middle remains a hole', hit(0), undefined);
      checks.near(
        'two occupied cells determine mass',
        h.physics.getDerivedBodyMass(entity) ?? Number.NaN,
        14,
      );
      const cancelled = h.physics.prepareDerivedShapeCandidate(input(2, true)).unwrap();
      h.tick();
      checks.equal('preparation does not change current collision', hit(-1.5), entity);
      h.physics.cancelDerivedShapeCandidate(cancelled).unwrap();
      h.tick();
      checks.equal(
        'cancel retains the publication',
        h.physics.getDerivedPublication(entity)?.revision,
        1,
      );
      const refused = h.physics.prepareDerivedShapeCandidate(input(3, true)).unwrap();
      h.physics
        .admitDerivedShapeCandidate(refused, () => err(new Error('lab geometry refusal')))
        .unwrap();
      h.tick();
      checks.equal('refused geometry retains old collision', hit(-1.5), entity);
      checks.equal(
        'refused geometry retains revision',
        h.physics.getDerivedPublication(entity)?.revision,
        1,
      );
      h.physics
        .admitDerivedShapeCandidate(h.physics.prepareDerivedShapeCandidate(input(4, true)).unwrap())
        .unwrap();
      h.tick();
      checks.equal('accepted removal opens the cell', hit(-1.5), undefined);
      checks.equal('unmodified occupied cell still blocks', hit(1.5), entity);
      checks.near(
        'accepted edit updates mass',
        h.physics.getDerivedBodyMass(entity) ?? Number.NaN,
        7,
      );
      const invalid = input(5);
      checks.equal(
        'malformed regions are refused',
        h.physics.prepareDerivedShapeCandidate({
          ...invalid,
          shapes: [
            {
              id: 'wall',
              revision: 5,
              kind: 'voxels',
              regions: Int32Array.of(0, 0, 0, 1),
              voxelSize: [1, 1, 1],
            },
          ],
        }).ok,
        false,
      );
      checks.equal(
        'invalid edit retains revision',
        h.physics.getDerivedPublication(entity)?.revision,
        4,
      );
    } finally {
      h.dispose();
    }
  },
});
