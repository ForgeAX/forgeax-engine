import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createMaterialProgramArtifactReceipt,
  ShaderRegistry,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import type { RenderPublication } from '../contract';
import { installPublicationPrograms } from '../programs';

afterEach(() => vi.restoreAllMocks());

function program(key = 'forgeax::publication-program') {
  const paramSchema = STANDARD_PIPELINE_PARAM_SCHEMA;
  return {
    key,
    shader: {
      source: '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }',
      paramSchema,
      receipt: createMaterialProgramArtifactReceipt({
        schema: paramSchema,
        directEntry: 'vs_main',
        vertexInputs: [],
      }),
    },
    artifact: {
      key,
      digest: 'same-producer-digest',
      bytes: new Uint8Array([1, 2, 3, 4]),
      metadata: { paramSchema, abi: 3, receipt: { identity: key } },
    },
  } satisfies RenderPublication['programs'][number];
}

it('does not re-admit unchanged programs across 60 Worker-cloned publications', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  const installed = assets.shaderRegistry.findMaterialArtifact(row.key).unwrap();
  const admit = vi.spyOn(ShaderRegistry.prototype, 'installMaterialArtifact');
  for (let frame = 0; frame < 60; frame++) {
    installPublicationPrograms(assets, structuredClone([row]));
    expect(assets.shaderRegistry.findMaterialArtifact(row.key).unwrap()).toBe(installed);
  }
  expect(admit).not.toHaveBeenCalled();
});

it('admits a cold publication once and retains its validated program and schema facts', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = structuredClone(program());
  const admit = vi.spyOn(ShaderRegistry.prototype, 'installMaterialArtifact');
  const reflect = vi.spyOn(ShaderRegistry.prototype, 'materialProgram');
  installPublicationPrograms(assets, [row]);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(reflect).toHaveBeenCalledTimes(1);
  const validation = admit.mock.contexts[0];
  if (!(validation instanceof ShaderRegistry)) throw new Error('Missing validation registry');
  const validated = validation.findMaterialArtifact(row.key).unwrap();
  const accepted = assets.shaderRegistry.findMaterialArtifact(row.key).unwrap();
  expect(accepted.program).toBe(validated.program);
  expect(accepted.paramSchema).toBe(validated.paramSchema);
  expect(accepted.paramSchemaProjection.derivedInterface).toBe(
    validated.paramSchemaProjection.derivedInterface,
  );
  expect(validation.paramSchemaProjectionStats().derivations).toBe(1);
  expect(assets.shaderRegistry.paramSchemaProjectionStats()).toEqual({
    admissions: 1,
    derivations: 0,
    projections: 1,
  });
});

it('fully admits the same publication in a new registry', () => {
  const row = program();
  const first = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  installPublicationPrograms(first, [row]);
  const next = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  installPublicationPrograms(next, structuredClone([row]));
  expect(next.shaderRegistry.paramSchemaProjectionStats().projections).toBe(1);
  expect(next.shaderRegistry.findMaterialArtifact(row.key).unwrap()).not.toBe(
    first.shaderRegistry.findMaterialArtifact(row.key).unwrap(),
  );
});

it.each([
  'source',
  'schema',
  'receipt',
  'invalid-receipt',
] as const)('rejects a same-key %s change and permits a corrected batch retry', (dimension) => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  const fresh = program('forgeax::fresh-program');
  const changed = structuredClone(row);
  if (dimension === 'source') Object.assign(changed.shader, { source: 'changed' });
  if (dimension === 'schema')
    Object.assign(changed.shader, { paramSchema: [{ name: 'changed', type: 'f32' }] });
  if (dimension === 'receipt') Object.assign(changed.shader.receipt, { directEntry: 'changed' });
  if (dimension === 'invalid-receipt')
    Object.assign(changed.shader.receipt, { generation: Number.NaN });
  expect(() => installPublicationPrograms(assets, [fresh, changed])).toThrow();
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(false);
  expect(assets.getMaterialArtifact(fresh.key)).toBeUndefined();
  expect(assets.shaderRegistry.findMaterialArtifact(row.key).unwrap().source).toBe(
    row.shader.source,
  );
  installPublicationPrograms(assets, [fresh, structuredClone(row)]);
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(true);
  expect(assets.getMaterialArtifact(fresh.key)).toBeDefined();
});

it.each([
  'bytes',
  'paramSchema',
  'abi',
  'receipt',
] as const)('compares repeated artifact %s even when its producer digest is unchanged', (dimension) => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  const changed = structuredClone(row);
  const artifact = changed.artifact;
  if (dimension === 'bytes') artifact.bytes[2] = 9;
  else Object.assign(artifact.metadata, { [dimension]: 'changed' });
  const fresh = program('forgeax::fresh-program');
  expect(() => installPublicationPrograms(assets, [fresh, changed])).toThrow();
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(false);
  expect(assets.getMaterialArtifact(fresh.key)).toBeUndefined();
  installPublicationPrograms(assets, [fresh, structuredClone(row)]);
  expect(assets.getMaterialArtifact(row.key)?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
});

it('still validates an installed receipt when the incoming object was mutated in place', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  Object.assign(row.shader.receipt, { generation: Number.NaN });
  expect(() => installPublicationPrograms(assets, [row])).toThrow();
  expect(assets.shaderRegistry.findMaterialArtifact(row.key).unwrap().receipt?.generation).toBe(3);
});

it('owns receipt content so an in-place valid change cannot alter the admitted program', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  const installed = assets.shaderRegistry.findMaterialArtifact(row.key).unwrap();
  Object.assign(row.shader.receipt.materialRow, { byteLength: 4096 });
  expect(() => installPublicationPrograms(assets, [row])).toThrow('conflicting immutable shader');
  expect(installed.receipt?.materialRow.byteLength).not.toBe(4096);
  expect(Object.isFrozen(installed.receipt?.materialRow)).toBe(true);
});

it('does not trust schema JSON hooks as evidence of unchanged parameter content', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const row = program();
  installPublicationPrograms(assets, [row]);
  const changed = structuredClone(row);
  const parameter = changed.shader.paramSchema[0];
  if (parameter === undefined) throw new Error('Missing fixture parameter');
  Object.assign(parameter, { type: 'invalid' });
  Object.assign(changed.shader.paramSchema, { toJSON: () => row.shader.paramSchema });
  expect(JSON.stringify(changed.shader.paramSchema)).toBe(JSON.stringify(row.shader.paramSchema));
  expect(() => installPublicationPrograms(assets, [changed])).toThrow();
});

it('rejects undeclared sampled textures on first admission without retaining the earlier program', () => {
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const fresh = program();
  const invalid = {
    key: 'game::undeclared-texture',
    shader: {
      source: `@group(1) @binding(0) var baseColorTexture: texture_2d<f32>;
@group(1) @binding(1) var tex_sampler: sampler;
fn sample() -> vec4f { return textureSample(baseColorTexture, tex_sampler, vec2f(0)); }`,
      paramSchema: [],
    },
  };
  expect(() => installPublicationPrograms(assets, [fresh, invalid])).toThrow('samples texture');
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(false);
  expect(assets.getMaterialArtifact(fresh.key)).toBeUndefined();
  installPublicationPrograms(assets, [fresh]);
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(true);
});

it('rejects conflicting programs atomically and preserves the installed shader', () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry(shaders);
  const first = { key: 'forgeax::publication-test', shader: { source: 'first', paramSchema: [] } };
  installPublicationPrograms(assets, [first]);
  expect(() =>
    installPublicationPrograms(assets, [
      { key: 'forgeax::new-test', shader: { source: 'new', paramSchema: [] } },
      { ...first, shader: { ...first.shader, source: 'conflict' } },
    ]),
  ).toThrow('conflicting immutable shader');
  expect(shaders.findMaterialArtifact('forgeax::new-test').ok).toBe(false);
  expect(shaders.findMaterialArtifact(first.key).unwrap().source).toBe('first');
  expect(() => installPublicationPrograms(assets, [first, first])).toThrow('duplicate');
  expect(() =>
    installPublicationPrograms(assets, [
      { ...first, artifact: { key: 'wrong', bytes: new Uint8Array() } },
    ]),
  ).toThrow('mismatched');
});
