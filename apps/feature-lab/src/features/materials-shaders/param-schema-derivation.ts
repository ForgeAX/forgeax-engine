import { derive, type ParamSchemaEntry } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

const SCHEMA: readonly ParamSchemaEntry[] = [
  { name: 'tint', type: 'color' },
  { name: 'strength', type: 'f32' },
  { name: 'albedo', type: 'texture2d' },
];

export default defineFeature({
  title: 'Material paramSchema derivation',
  catalog: 'Material `paramSchema` derivation',
  kind: 'headless',
  summary:
    'derive(schema) is the only source of the material bind-group layout, uniform offsets, texture fields and auto-paired samplers.',
  expect:
    'All checks pass: one uniform plus texture and auto-paired sampler bindings, std140 offsets, a stable layout identity, and a different identity for a different schema.',
  run(checks) {
    const derived = derive(SCHEMA);
    const kinds = derived.bglEntries.map((entry) =>
      entry.buffer !== undefined
        ? 'buffer'
        : entry.texture !== undefined
          ? 'texture'
          : entry.sampler !== undefined
            ? 'sampler'
            : 'other',
    );
    checks.equal('binding kinds', kinds, ['buffer', 'sampler', 'texture']);
    checks.ok('texture field recorded', derived.textureFieldNames.has('albedo'));
    checks.equal('auto-paired sampler', derived.samplerForTexture.get('albedo'), 'albedo_sampler');
    const offsets = Object.fromEntries(
      derived.uboLayout.entries.map((entry) => [entry.name, entry.offset]),
    );
    checks.equal('tint offset', offsets.tint, 0);
    checks.equal('strength offset (after vec4)', offsets.strength, 16);
    checks.ok(
      'uniform size is 16-byte aligned',
      derived.uboLayout.totalBytes % 16 === 0,
      `${derived.uboLayout.totalBytes}`,
    );
    checks.equal(
      'derive is deterministic',
      derive([...SCHEMA]).layoutIdentity,
      derived.layoutIdentity,
    );
    const other = derive([...SCHEMA, { name: 'extra', type: 'vec2' }]);
    checks.ok('schema change changes identity', other.layoutIdentity !== derived.layoutIdentity);
  },
});
