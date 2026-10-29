import { createHash } from 'node:crypto';
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const row = structuredClone(program());
  const admit = vi.spyOn(ShaderRegistry.prototype, 'installMaterialArtifact');
  installPublicationPrograms(assets, [row]);
  expect(admit).toHaveBeenCalledTimes(1);
  const validation = admit.mock.contexts[0];
  if (!(validation instanceof ShaderRegistry)) throw new Error('Missing validation registry');
  const validated = validation.findMaterialArtifact(row.key).unwrap();
  const accepted = assets.shaderRegistry.findMaterialArtifact(row.key).unwrap();
  expect(accepted.program).toBe(validated.program);
  expect(accepted.paramSchema).toBe(validated.paramSchema);
  expect(accepted.paramSchemaProjection.derivedInterface).toBe(
    validated.paramSchemaProjection.derivedInterface,
  );
  // Equal schema content admitted earlier in this realm is shared, not derived again.
  expect(validation.paramSchemaProjectionStats().derivations).toBeLessThanOrEqual(1);
  expect(assets.shaderRegistry.paramSchemaProjectionStats()).toEqual({
    admissions: 1,
    derivations: 0,
    projections: 1,
  });
});

it('reuses startup program analysis inside isolated Worker publication validation', () => {
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry({ shaderRegistry: registry });
  const row = structuredClone(program());
  const warmed = registry.materialProgram(row.shader.source);
  installPublicationPrograms(assets, [row]);
  expect(registry.findMaterialArtifact(row.key).unwrap().program).toBe(warmed);
  const changed = {
    ...program('forgeax::new-source'),
    shader: { ...row.shader, source: `${row.shader.source}\n// changed source` },
  };
  installPublicationPrograms(assets, [changed]);
  expect(registry.findMaterialArtifact(changed.key).unwrap().program).not.toBe(warmed);
});

it('fully admits the same publication in a new registry', () => {
  const row = program();
  const first = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  installPublicationPrograms(first, [row]);
  const next = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const row = program();
  installPublicationPrograms(assets, [row]);
  Object.assign(row.shader.receipt, { generation: Number.NaN });
  expect(() => installPublicationPrograms(assets, [row])).toThrow();
  expect(assets.shaderRegistry.findMaterialArtifact(row.key).unwrap().receipt?.generation).toBe(5);
});

it('owns receipt content so an in-place valid change cannot alter the admitted program', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const row = program();
  installPublicationPrograms(assets, [row]);
  const installed = assets.shaderRegistry.findMaterialArtifact(row.key).unwrap();
  Object.assign(row.shader.receipt.materialRow, { byteLength: 4096 });
  expect(() => installPublicationPrograms(assets, [row])).toThrow('conflicting immutable shader');
  expect(installed.receipt?.materialRow.byteLength).not.toBe(4096);
  expect(Object.isFrozen(installed.receipt?.materialRow)).toBe(true);
});

it('does not trust schema JSON hooks as evidence of unchanged parameter content', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
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
  assets.shaderRegistry.materialProgram(invalid.shader.source);
  expect(() => installPublicationPrograms(assets, [fresh, invalid])).toThrow('samples texture');
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(false);
  expect(assets.getMaterialArtifact(fresh.key)).toBeUndefined();
  installPublicationPrograms(assets, [fresh]);
  expect(assets.shaderRegistry.findMaterialArtifact(fresh.key).ok).toBe(true);
});

it('rejects conflicting programs atomically and preserves the installed shader', () => {
  const shaders = new ShaderRegistry({ manifestUrl: undefined });
  const assets = new AssetRegistry({ shaderRegistry: shaders });
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

it('shares equal ABI facts between separately received programs without freezing the input', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const first = structuredClone(program('forgeax::interned-a'));
  const second = structuredClone(program('forgeax::interned-b'));
  installPublicationPrograms(assets, [first]);
  installPublicationPrograms(assets, [second]);
  const a = assets.shaderRegistry.findMaterialArtifact(first.key).unwrap();
  const b = assets.shaderRegistry.findMaterialArtifact(second.key).unwrap();
  // Two Worker clones of equal facts resolve to one canonical receipt and schema.
  expect(b.receipt).toBe(a.receipt);
  expect(b.paramSchema).toBe(a.paramSchema);
  expect(Object.isFrozen(a.receipt)).toBe(true);
  // The received rows stay the caller's mutable values.
  expect(Object.isFrozen(first.shader.receipt)).toBe(false);
});

function byteProgram(key = 'game::byte-program') {
  const source = `@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); } // ${key}`;
  const bytes = new TextEncoder().encode(source);
  return {
    key,
    shader: {
      sourceEncoding: 'utf8' as const,
      paramSchema: [],
      entryPoints: [{ name: 'vs_main', stage: 'vertex' as const, bindings: [] }],
    },
    artifact: { key, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
  } satisfies RenderPublication['programs'][number];
}

it('owns byte publications and rejects late tampering atomically without decoding', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const first = byteProgram();
  const fresh = byteProgram('game::fresh-byte');
  const changed = structuredClone(first);
  changed.artifact.bytes[0] = 0;
  const decode = vi.spyOn(TextDecoder.prototype, 'decode');
  expect(() => installPublicationPrograms(assets, [fresh, changed])).toThrow();
  expect(assets.shaderRegistry.materialArtifactDeclaration(fresh.key)).toBeUndefined();
  expect(assets.getMaterialArtifact(fresh.key)).toBeUndefined();
  installPublicationPrograms(assets, structuredClone([first, fresh]));
  expect(decode).not.toHaveBeenCalled();
  installPublicationPrograms(assets, structuredClone([first, fresh]));
  expect(decode).not.toHaveBeenCalled();
  const original = new TextDecoder().decode(first.artifact.bytes);
  decode.mockClear();
  // Caller-owned bytes cannot change the accepted lazy source.
  first.artifact.bytes.fill(0);
  expect(assets.shaderRegistry.findMaterialArtifact(first.key).unwrap().source).toBe(original);
  expect(decode).toHaveBeenCalledTimes(1);
  expect(assets.shaderRegistry.materialArtifactDeclaration(fresh.key)?.kind).toBe('bytes');
});

it('rejects byte publication metadata conflicts before admission, including repeated entry reads', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const first = byteProgram();
  installPublicationPrograms(assets, [first]);
  const changed = structuredClone(first);
  const reads = changed.shader.entryPoints[0];
  if (reads === undefined) throw new Error('Missing entry reads');
  reads.name = 'changed';
  const fresh = byteProgram('game::metadata-fresh');
  expect(() => installPublicationPrograms(assets, [fresh, changed])).toThrow(
    'conflicting immutable shader',
  );
  expect(assets.shaderRegistry.materialArtifactDeclaration(fresh.key)).toBeUndefined();
  expect(assets.shaderRegistry.materialArtifactDeclaration(first.key)?.kind).toBe('bytes');
  installPublicationPrograms(assets, [fresh, first]);
});

it('admits mixed direct and lazy rows while checking source-dependent errors on first use', () => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const lazy = byteProgram();
  const direct = program();
  installPublicationPrograms(assets, [direct, lazy]);
  expect(assets.shaderRegistry.materialArtifactDeclaration(direct.key)?.kind).toBe('ready');
  expect(assets.shaderRegistry.materialArtifactDeclaration(lazy.key)?.kind).toBe('bytes');
  const bytes = new TextEncoder().encode('fn bad() { textureSample(baseColorTexture, s, uv); }');
  const invalid = {
    ...byteProgram('game::invalid-byte-source'),
    artifact: {
      key: 'game::invalid-byte-source',
      bytes,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
  installPublicationPrograms(assets, [invalid]);
  expect(() => assets.shaderRegistry.findMaterialArtifact(invalid.key)).toThrow('samples texture');
  expect(assets.shaderRegistry.materialArtifactDeclaration(invalid.key)?.kind).toBe('bytes');
});

it.each([
  'encoding',
  'artifact',
  'digest',
] as const)('rejects an incomplete byte publication %s before committing earlier rows', (dimension) => {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const first = byteProgram('game::shape-first');
  const invalid = byteProgram('game::shape-invalid');
  if (dimension === 'encoding') Object.assign(invalid.shader, { sourceEncoding: 'unknown' });
  if (dimension === 'artifact') Object.assign(invalid, { artifact: undefined });
  if (dimension === 'digest') Object.assign(invalid.artifact, { digest: undefined });
  expect(() => installPublicationPrograms(assets, [first, invalid])).toThrow('complete artifact');
  expect(assets.shaderRegistry.materialArtifactDeclaration(first.key)).toBeUndefined();
  expect(assets.getMaterialArtifact(first.key)).toBeUndefined();
});
