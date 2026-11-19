import { defineComponent } from '@forgeax/engine/ecs';
import {
  projectComponentData,
  validateProfileComponents,
} from '@forgeax/engine/ecs/externalization';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Externalization and entity remap',
  catalog: 'Externalization/remap',
  kind: 'headless',
  summary:
    'projectComponentData strips transient fields and remaps entity references; validateProfileComponents rejects non-portable fields.',
  expect:
    'All checks pass: transient data disappears, entity and array<entity> fields are remapped, shared<> fields are non-portable, and fully transient components are rejected.',
  run(checks) {
    const Link = defineComponent('FLExtLink', {
      target: 'entity',
      group: 'array<entity>',
      hp: 'f32',
      cache: { type: 'f32', transient: true },
    });
    const Mesh = defineComponent('FLExtMesh', {
      mesh: 'asset<mesh>',
      peers: 'array<shared<Mesh>>',
    });
    const Scratch = defineComponent('FLExtScratch', { t: 'f32' }, { transient: true });
    const mapping = [100, 101, 102, 103];
    const remap = (entity: number) => mapping[entity] ?? entity;
    const out = projectComponentData(Link, { target: 2, group: [1, 3, 9], hp: 7, cache: 9 }, remap);
    checks.equal('entity remapped', out.target, 102);
    checks.equal(
      'mapped entries change and missing entries retain identity',
      out.group,
      [101, 103, 9],
    );
    checks.equal('plain value kept', out.hp, 7);
    checks.ok('transient field removed', !('cache' in out));
    checks.equal(
      'fully transient component projects empty',
      projectComponentData(Scratch, { t: 1 }),
      {},
    );
    const verdict = validateProfileComponents([Link, Mesh, Scratch]);
    checks.ok('profile invalid', !verdict.valid);
    checks.equal(
      'profile error codes',
      verdict.errors.map((e) => `${e.component}:${e.field ?? e.code}`),
      ['FLExtMesh:mesh', 'FLExtMesh:peers', 'FLExtScratch:component-fully-transient'],
    );
  },
});
