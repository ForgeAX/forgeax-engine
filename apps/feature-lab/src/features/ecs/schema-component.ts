import { defineComponent, World } from '@forgeax/engine/ecs';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Schema-defined component',
  catalog: 'Schema-defined component',
  kind: 'headless',
  summary:
    'defineComponent returns a frozen token over a closed field vocabulary: numeric, bool, string, entity, shared, fixed and variable arrays.',
  expect:
    'All checks pass: every field kind round-trips, defaults fill missing fields, and unsupported types / NaN / unknown fields are rejected.',
  run(checks) {
    const Rich = defineComponent('FLSchemaRich', {
      speed: { type: 'f32', default: 3 },
      count: 'u32',
      alive: 'bool',
      label: { type: 'string', default: 'none' },
      target: 'entity',
      mesh: 'shared<MeshAsset>',
      tint: 'array<f32, 4>',
      path: 'array<f32>',
    });
    checks.equal('token name', Rich.name, 'FLSchemaRich');
    checks.ok('token frozen', Object.isFrozen(Rich));
    checks.ok('fields frozen', Object.isFrozen(Rich.fields));
    checks.equal('field names', Object.keys(Rich.fields).sort(), [
      'alive',
      'count',
      'label',
      'mesh',
      'path',
      'speed',
      'target',
      'tint',
    ]);
    checks.equal('storage default table', Rich.storage, 'table');

    const world = new World();
    const target = world.spawn().unwrap();
    const e = world.spawn({
      component: Rich,
      data: {
        count: 7,
        alive: true,
        target,
        tint: new Float32Array([1, 0.5, 0.25, 1]),
        path: new Float32Array([1, 2, 3]),
      },
    });
    checks.ok('spawn with every kind', e.ok, e.ok ? undefined : e.error.code);
    if (e.ok) {
      const v = world.get(e.value, Rich).unwrap();
      checks.near('default speed', v.speed, 3);
      checks.equal('u32', v.count, 7);
      checks.equal('bool', v.alive, true);
      checks.equal('default string', v.label, 'none');
      checks.equal('entity ref', v.target, target);
      checks.equal('fixed array', Array.from(v.tint), [1, 0.5, 0.25, 1]);
      checks.equal('variable array', Array.from(v.path), [1, 2, 3]);
      const nan = world.set(e.value, Rich, { speed: Number.NaN });
      checks.equal(
        'NaN rejected',
        nan.ok ? 'ok' : nan.error.code,
        'component-numeric-value-invalid',
      );
      checks.near('value unchanged after NaN', world.get(e.value, Rich).unwrap().speed, 3);
    }
    let unsupported = 'none';
    try {
      defineComponent('FLSchemaBad', { x: 'f16' as 'f32' });
    } catch (error) {
      unsupported = (error as { code?: string }).code ?? 'thrown';
    }
    checks.equal('unsupported field type', unsupported, 'schema-unsupported-field');
    const unknown = world.spawn({ component: Rich, data: { nope: 1 } as never });
    checks.equal(
      'unknown spawn field',
      unknown.ok ? 'ok' : unknown.error.code,
      'spawn-data-unknown-field',
    );
  },
});
