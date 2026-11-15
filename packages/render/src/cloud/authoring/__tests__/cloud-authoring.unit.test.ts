import { AssetGuid } from '@forgeax/engine-pack/guid';
import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { err, ok, type TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { CloudMaterialAsset, CloudMaterialSource } from '../../contracts';
import { cloudAuthoringError } from '../../errors';
import { createCloudCookers } from '../assets';
import { cloudIdentity } from '../identity';
import { validateCloudLayer } from '../layer';
import { validateCloudMaterial } from '../material';
import { CloudPublication, type CloudPublicationLease } from '../publication';
import { resolveCloudMaterial, verifyCloudTexture } from '../resolve';

const location = { guid: '019a50a5-0000-7000-8000-000000000004', source: 'clouds.pack.ts' };
const textureGuid = '019a50a5-0000-7000-8000-000000000005';
const source = {
  version: 1,
  model: { kind: 'program', source: 'fixture.wgsl' },
  parameters: {
    extinction: { kind: 'scalar', unit: 'm^-1', default: 0.002, range: [0, 1] },
    detail: { kind: 'static', default: false },
    noise: {
      kind: 'texture',
      default: textureGuid,
      dimension: '3d',
      colorSpace: 'linear',
      mipLevels: 1,
    },
  },
} satisfies CloudMaterialSource;
const sample = {
  extinctionPerMeter: 0.002,
  albedo: [1, 0.9, 0.8],
  emissivePerMeter: [0, 0, 0],
  materialAO: 1,
};
const volume = {
  kind: 'texture',
  shape: { viewDimension: '3d', extent: { width: 2, height: 2, depth: 2 } },
  format: 'rgba8unorm',
  colorSpace: 'linear',
  mips: { kind: 'none' },
  data: new Uint8Array(32),
} satisfies TextureAsset;

function testCookers() {
  const registry = new NativeCookerRegistry();
  const compile = vi.fn(async (wgsl: string) => ok({ wgsl, bindings: [{ entries: [] }] }));
  for (const cooker of createCloudCookers({
    loadSource: async () => ({ source: '// producer fixture', path: 'fixture.wgsl' }),
    compilerIdentity: async () => 'fixture-compiler',
    compile,
  }))
    registry.register(cooker);
  return { registry, compile };
}

describe('cloud material authoring', () => {
  it('accepts zero extinction and rejects nonfinite extinction, invalid AO, and traversal', () => {
    const uniform = { version: 1, model: { kind: 'uniform', sample }, parameters: {} };
    expect(validateCloudMaterial(uniform, location).ok).toBe(true);
    for (const [key, value] of [
      ['extinctionPerMeter', Infinity],
      ['materialAO', 1.1],
    ]) {
      const result = validateCloudMaterial(
        {
          ...uniform,
          model: { kind: 'uniform', sample: { ...sample, [String(key)]: value } },
        },
        location,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { detail: { ...location, field: `model.sample.${key}` } },
      });
    }
    expect(
      validateCloudMaterial(
        { ...source, model: { kind: 'program', source: '../a.wgsl' } },
        location,
      ).ok,
    ).toBe(false);
    expect(
      validateCloudMaterial(
        { ...uniform, model: { ...uniform.model, sample: { ...sample, extinctionPerMeter: 0 } } },
        location,
      ).ok,
    ).toBe(true);
  });

  it('keeps trace distance and thickness in meters with explicit trace distance origin', () => {
    const guid = AssetGuid.parse(location.guid);
    if (!guid.ok) throw guid.error;
    const layer = {
      material: guid.value,
      bottomMeters: 5000,
      thicknessMeters: 10_000,
      trace: {
        tracingStartMaxDistanceMeters: 350_000,
        tracingMaxDistanceMeters: 50_000,
        tracingMaxDistanceMode: 'from-layer-entry' as const,
        viewSampleCountScale: 1,
        shadowViewSampleCountScale: 1,
        stopTransmittance: 0.005,
      },
    };
    expect(validateCloudLayer(layer, location).unwrap()).toEqual(layer);
    expect(validateCloudLayer({ ...layer, thicknessMeters: 0 }, location)).toMatchObject({
      ok: false,
      error: { detail: { field: 'thicknessMeters' } },
    });
  });

  it('preserves the Pack GUID, cooks static variants and keeps value overrides out of program identity', async () => {
    const { registry, compile } = testCookers();
    const request = { guid: location.guid, sourcePath: location.source, source };
    const draft = (await registry.runDraft<CloudMaterialAsset>('cloud-material', request)).unwrap();
    const repeat = (await registry.runDraft('cloud-material', request)).unwrap();
    expect(draft).toEqual(repeat);
    expect(draft.guid).toBe(location.guid);
    expect(draft.refs).toEqual([textureGuid]);
    expect(draft.payload.variants.map((variant) => variant.staticValues)).toEqual([
      { detail: false },
      { detail: true },
    ]);
    expect(new Set(draft.payload.variants.map((variant) => variant.programIdentity)).size).toBe(2);
    expect(compile).toHaveBeenCalledTimes(4);
    const instance = {
      kind: 'cloud-material-instance' as const,
      version: 1 as const,
      material: location.guid,
      overrides: { extinction: 0.003 },
      parameterIdentity: cloudIdentity(source.parameters),
    };
    const textures = new Map([[textureGuid, volume]]);
    const base = resolveCloudMaterial(draft.payload, undefined, location, textures).unwrap();
    const overridden = resolveCloudMaterial(draft.payload, instance, location, textures).unwrap();
    expect(overridden.values.extinction).toBe(0.003);
    expect(overridden.variant?.programIdentity).toBe(base.variant?.programIdentity);
    expect(
      resolveCloudMaterial(
        draft.payload,
        { ...instance, overrides: { detail: true } },
        location,
        textures,
      ).unwrap().variant?.programIdentity,
    ).not.toBe(base.variant?.programIdentity);
    expect(resolveCloudMaterial(draft.payload, undefined, location, new Map())).toMatchObject({
      ok: false,
      error: { detail: { field: 'parameters.noise' } },
    });
  });

  it('rejects an identity that does not hash the supplied canonical density modules', async () => {
    const registry = new NativeCookerRegistry();
    const compile = vi.fn(async () => ok({ wgsl: '', bindings: [] }));
    for (const cooker of createCloudCookers({
      loadSource: async () => ({
        source: '// identity validation precedes compilation',
        path: 'fixture.wgsl',
        densityKernel: {
          identity: '0'.repeat(64),
          imports: {
            'forgeax_cloud::coordinates': '// coordinates',
            'forgeax_cloud::medium': '// medium',
          },
          sourcePaths: ['coordinates.wgsl', 'medium.wgsl'],
        },
      }),
      compilerIdentity: async () => 'fixture',
      compile,
    }))
      registry.register(cooker);
    const result = await registry.runDraft('cloud-material', {
      guid: location.guid,
      sourcePath: location.source,
      source,
    });
    expect(result.ok).toBe(false);
    expect(compile).not.toHaveBeenCalled();
    if (result.ok) throw new Error('Expected identity validation failure');
    expect(JSON.stringify(result.error)).toContain('densityKernelIdentity');
  });

  it('does not certify an authored wrapper merely because it supplies canonical module bytes', async () => {
    const registry = new NativeCookerRegistry();
    const compile = vi.fn(async () => ok({ wgsl: '', bindings: [] }));
    const imports = {
      'forgeax_cloud::coordinates': '// coordinates',
      'forgeax_cloud::medium': '// medium',
    };
    for (const cooker of createCloudCookers({
      loadSource: async () => ({
        source: '// unrelated authored wrapper',
        path: 'fixture.wgsl',
        densityKernel: {
          identity: cloudIdentity(imports).slice(7),
          imports,
          sourcePaths: ['coordinates.wgsl', 'medium.wgsl'],
        },
      }),
      compilerIdentity: async () => 'fixture',
      compile,
    }))
      registry.register(cooker);
    const result = await registry.runDraft('cloud-material', {
      guid: location.guid,
      sourcePath: location.source,
      source,
    });
    expect(result.ok).toBe(false);
    expect(compile).not.toHaveBeenCalled();
    if (result.ok) throw new Error('Expected fixed reference wrapper validation failure');
    expect(JSON.stringify(result.error)).toContain('model.source');
  });

  it('rejects a mismatched texture dimension, mip count or color encoding', () => {
    const spec = source.parameters.noise;
    expect(verifyCloudTexture(spec, volume)).toBe(true);
    expect(
      verifyCloudTexture(spec, { ...volume, format: 'rgba8unorm-srgb', colorSpace: 'srgb' }),
    ).toBe(false);
    expect(verifyCloudTexture(spec, { ...volume, mips: { kind: 'generate' } })).toBe(false);
    expect(
      verifyCloudTexture(spec, {
        ...volume,
        shape: { viewDimension: '2d', extent: { width: 2, height: 2 } },
      }),
    ).toBe(false);
  });
});

describe('cloud publication leases', () => {
  it('rejects late generations, reuses a revision, and retains the prior value on failure', async () => {
    const publication = new CloudPublication<number>();
    const oldRelease = vi.fn();
    const acceptedRelease = vi.fn();
    const accepted: CloudPublicationLease<number> = {
      revision: 'new',
      value: 2,
      release: acceptedRelease,
    };
    type Candidate = ReturnType<typeof ok<CloudPublicationLease<number>>>;
    let resolveOld: (candidate: Candidate) => void = () => {
      throw new Error('The old candidate has not been created');
    };
    const old = new Promise<Candidate>((resolve) => {
      resolveOld = resolve;
    });
    const pending = publication.prepare({ load: () => old }, location);
    expect((await publication.prepare({ load: async () => ok(accepted) }, location)).unwrap()).toBe(
      2,
    );
    resolveOld(ok({ revision: 'old', value: 1, release: oldRelease }));
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cloud-publication-stale' } });
    expect(oldRelease).toHaveBeenCalledOnce();
    const duplicateRelease = vi.fn();
    expect(
      (
        await publication.prepare(
          { load: async () => ok({ ...accepted, release: duplicateRelease }) },
          location,
        )
      ).unwrap(),
    ).toBe(2);
    expect(duplicateRelease).toHaveBeenCalledOnce();
    await publication.prepare(
      {
        load: async () =>
          err(cloudAuthoringError('cloud-dependency-invalid', location, 'material', 'missing')),
      },
      location,
    );
    expect(publication.current()).toBe(2);
    expect(acceptedRelease).not.toHaveBeenCalled();
    publication.dispose();
    expect(publication.current()).toBeUndefined();
    expect(acceptedRelease).toHaveBeenCalledOnce();
  });
});
