import { defineComponent } from '@forgeax/engine/ecs';
import {
  createEntityRemap,
  isFieldPortable,
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
    const Mesh = defineComponent('FLExtMesh', { mesh: 'shared<MeshAsset>' });
    const Scratch = defineComponent('FLExtScratch', { t: 'f32' }, { transient: true });
    const remap = createEntityRemap([100, 101, 102, 103]);
    const out = projectComponentData(Link, { target: 2, group: [1, 3], hp: 7, cache: 9 }, remap);
    checks.equal('entity remapped', out.target, 102);
    checks.equal('entity array remapped', out.group, [101, 103]);
    checks.equal('plain value kept', out.hp, 7);
    checks.ok('transient field removed', !('cache' in out));
    checks.equal(
      'fully transient component projects empty',
      projectComponentData(Scratch, { t: 1 }),
      {},
    );
    checks.equal('missing mapping keeps identity by default', remap(9), 9);
    let missing = 'none';
    try {
      createEntityRemap([0], { missing: 'error' })(5);
    } catch {
      missing = 'thrown';
    }
    checks.equal('missing mapping error mode', missing, 'thrown');
    checks.ok('f32 portable', isFieldPortable('f32'));
    checks.ok('shared<> not portable', !isFieldPortable('shared<MeshAsset>'));
    checks.ok('array<shared<>> not portable', !isFieldPortable('array<shared<MeshAsset>>'));
    const verdict = validateProfileComponents([Link, Mesh, Scratch]);
    checks.ok('profile invalid', !verdict.valid);
    checks.equal(
      'profile error codes',
      verdict.errors.map((e) => `${e.component}:${e.code}`),
      ['FLExtMesh:field-not-portable', 'FLExtScratch:component-fully-transient'],
    );
  },
});
