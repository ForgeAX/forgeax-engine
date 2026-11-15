import { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../../../../../shader-compiler/src/compile';
import { loadEngineShaderEntries } from '../../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import type { CloudMaterialAsset } from '../../contracts';
import { cloudMaterialDecoder, createCloudCookers } from '../assets';
import { cloudIdentity } from '../identity';
import { cloudRendererProgram, encodeCloudRendererParameters } from '../renderer-program';

const parameters = {
  centerMeters: { kind: 'scalar', default: 0, unit: 'm' },
  halfWidthMeters: { kind: 'scalar', default: 800, unit: 'm' },
  extinctionPerMeter: { kind: 'scalar', default: 0.002, unit: 'm^-1' },
} as const;
const source = `fn evaluateCloudMedium(context: CloudMediumContext, parameters: CloudParameters) -> CloudMediumSample {
  let inside = abs(context.positionMeters.z - parameters.centerMeters) <= parameters.halfWidthMeters && context.heightFraction >= 0.1 && context.heightFraction <= 0.8;
  return CloudMediumSample(select(0.0, parameters.extinctionPerMeter, inside), vec3f(0.98), vec3f(0.0), 1.0);
}`;

describe('generic cooked cloud renderer', () => {
  it('uses the shared stable Beer kernel for scattering and emission segment integrals', async () => {
    const program = cloudRendererProgram(source, parameters, {});
    expect(program).toContain('#import forgeax_cloud::trace::{cloud_one_minus_beer}');
    expect(
      program.match(/cloud_one_minus_beer\(opticalDepth, exp\(-opticalDepth\)\)/g),
    ).toHaveLength(2);
    expect(program).not.toMatch(/1\.0 - exp\(-.*ds\)/);
    const engine = await loadEngineShaderEntries();
    const compiled = await compileShader(program, {
      id: 'test-cloud-stable-beer.wgsl',
      imports: engine.imports,
    });
    if (!compiled.ok) throw compiled.error;
    expect(compiled.value.reflection.entryPoints?.some((entry) => entry.name === 'fs_main')).toBe(
      true,
    );
  }, 30000);

  it('keeps atmosphere resources out of the stock raw entries and in the air entries', async () => {
    const engine = await loadEngineShaderEntries();
    const sampled = engine.cloudAtmosphere.filter((entry) =>
      entry.reservedIdentifier?.startsWith('forgeax::cloud-sampled-view-'),
    );
    expect(sampled).toHaveLength(2);
    for (const entry of [engine.cloudAnalytic, ...sampled]) {
      const compiled = await compileShader(entry.source, { id: entry.id, imports: engine.imports });
      if (!compiled.ok) throw compiled.error;
      if (entry !== engine.cloudAnalytic)
        expect(
          compiled.value.reflection.entryPoints?.some((point) => point.name === 'fs_shadow'),
        ).toBe(true);
      const raw = compiled.value.reflection.entryPoints?.find(
        (point) => point.name === 'fs_trace_mode_zero',
      );
      const air = compiled.value.reflection.entryPoints?.find(
        (point) => point.name === 'fs_trace_mode_zero_air',
      );
      if (raw === undefined || air === undefined)
        throw new Error('Missing stock cloud fog entries');
      const atmosphereSlots = (point: typeof raw) =>
        point.bindings
          .filter((binding) => binding.group === 0 && [18, 19, 20, 21].includes(binding.binding))
          .map((binding) => binding.binding)
          .sort((a, b) => a - b);
      expect(atmosphereSlots(raw)).toEqual([]);
      expect(atmosphereSlots(air)).toEqual([18, 19, 20, 21]);
    }
  }, 30000);

  it('composes actual authored textureless medium in both primary and shadow entries', async () => {
    const engine = await loadEngineShaderEntries();
    const result = await compileShader(cloudRendererProgram(source, parameters, {}), {
      id: 'test-cloud-renderer.wgsl',
      imports: engine.imports,
    });
    if (!result.ok) throw result.error;
    expect(result.value.wgsl).toContain('fs_shadow');
    expect(result.value.wgsl).toContain('fs_main');
    expect(
      result.value.bindings
        .filter((_group, index) => index === 1)
        .flatMap((group) => group.entries)
        .filter((entry) => entry.texture?.viewDimension === '3d'),
    ).toEqual([]);
    const entries = result.value.reflection.entryPoints;
    const raw = entries?.find((entry) => entry.name === 'fs_trace_mode_zero');
    const air = entries?.find((entry) => entry.name === 'fs_trace_mode_zero_air');
    if (raw === undefined || air === undefined) throw new Error('Missing cloud fog entry points');
    const atmosphereSlots = (entry: NonNullable<typeof raw>) =>
      entry.bindings
        .filter((binding) => binding.group === 0 && [18, 19, 20, 21].includes(binding.binding))
        .map((binding) => binding.binding)
        .sort((a, b) => a - b);
    expect(atmosphereSlots(raw)).toEqual([]);
    expect(atmosphereSlots(air)).toEqual([18, 19, 20, 21]);
  }, 30000);

  it('compiles the production shadow entry together with the camera-limit GPU witness', async () => {
    const engine = await loadEngineShaderEntries();
    const compiled = await compileShader(
      `${cloudRendererProgram(source, parameters, {})}
@group(2) @binding(0) var<storage, read_write> cameraInterval: array<f32>;
@compute @workgroup_size(1) fn camera_probe() {
  let interval = renderer_interval(vec3f(0.0), vec3f(0.0,1.0,0.0), 200000.0);
  cameraInterval[0] = interval.x; cameraInterval[1] = interval.y;
}`,
      { id: 'cloud-shadow-coverage-compile-test.wgsl', imports: engine.imports },
    );
    if (!compiled.ok) throw compiled.error;
    expect(compiled.value.reflection.entryPoints?.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['fs_shadow', 'camera_probe', 'fs_main']),
    );
  }, 30000);

  it('packs resolved instance values without changing the authored program', () => {
    const data = encodeCloudRendererParameters(parameters, {
      centerMeters: 5,
      extinctionPerMeter: 0.01,
      halfWidthMeters: 1600,
    });
    expect(data.length).toBe(4);
    expect(data[0]).toBe(5);
    expect(data[1]).toBeCloseTo(0.01);
    expect(data[2]).toBe(1600);
    expect(() =>
      encodeCloudRendererParameters(parameters, {
        centerMeters: 0,
        extinctionPerMeter: Number.NaN,
        halfWidthMeters: 800,
      }),
    ).toThrow();
  });

  it('publishes both artifacts atomically and rejects corrupted renderer bytes', async () => {
    const engine = await loadEngineShaderEntries();
    const registry = new NativeCookerRegistry();
    for (const cooker of createCloudCookers({
      loadSource: async () => ({ source, path: 'cloud-band.wgsl' }),
      loadRendererModules: async () => ({ imports: engine.imports, sourcePaths: [] }),
      compilerIdentity: async () => 'actual-test-compiler',
      compile: (code, id, imports) =>
        compileShader(code, { id, ...(imports === undefined ? {} : { imports }) }),
    }))
      registry.register(cooker);
    const draft = (
      await registry.runDraft<CloudMaterialAsset>('cloud-material', {
        guid: '019a50a5-0000-7000-8000-000000000004',
        sourcePath: 'clouds.pack.ts',
        source: { version: 1, model: { kind: 'program', source: 'cloud-band.wgsl' }, parameters },
      })
    ).unwrap();
    expect(draft.refs).toEqual([]);
    expect(draft.payload.version).toBe(2);
    const variant = draft.payload.variants[0];
    expect(variant?.renderer).toBeDefined();
    const artifacts = Object.fromEntries(
      Object.entries(draft.artifacts).map(([key, value]) => [
        key,
        { path: key, mediaType: value.mediaType },
      ]),
    );
    const decode = (corrupt: boolean, payload = draft.payload) =>
      cloudMaterialDecoder.decoder.decode({
        envelope: { guid: draft.guid, payload, refs: draft.refs, artifacts },
        artifacts: {
          read: async (descriptor: { path: string }) =>
            ok(
              corrupt && descriptor.path.startsWith('renderer-')
                ? new TextEncoder().encode('corrupt')
                : (draft.artifacts[descriptor.path]?.bytes ?? new Uint8Array()),
            ),
        },
        signal: new AbortController().signal,
      } as never);
    const accepted = await decode(false);
    expect(accepted.ok).toBe(true);
    if (accepted.ok && variant !== undefined)
      expect(accepted.value.rendererPrograms?.[variant.programIdentity]).toContain('fs_shadow');
    expect((await decode(true)).ok).toBe(false);
    const { cookIdentity: _cookIdentity, ...facts } = draft.payload;
    const legacyFacts = {
      ...facts,
      variants: facts.variants.map((variant) => {
        const renderer = { ...variant.renderer } as Record<string, unknown>;
        delete renderer.uniformAbiVersion;
        return {
          ...variant,
          renderer,
          programIdentity: cloudIdentity({
            compiler: variant.compilerIdentity,
            programDigest: variant.programDigest,
            staticValues: variant.staticValues,
            renderer,
          }),
        };
      }),
    };
    const legacy = {
      ...legacyFacts,
      cookIdentity: cloudIdentity(legacyFacts),
    } as unknown as CloudMaterialAsset;
    const stale = await decode(false, legacy);
    expect(stale.ok, 'self-consistent older renderer ABI must require cold Cook').toBe(false);
    if (!stale.ok) expect(stale.error.hint).toContain('cold-cook');
  }, 30000);
});
