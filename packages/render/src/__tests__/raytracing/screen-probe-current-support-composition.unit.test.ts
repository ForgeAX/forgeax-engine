import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  SCREEN_PROBE_CURRENT_SUPPORT_MASK,
  SCREEN_PROBE_RECONSTRUCTION_WGSL,
} from '../../../../shader/src/screen-probe-reconstruction';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import {
  SCREEN_PROBE_BINDINGS,
  SCREEN_PROBE_IRRADIANCE_SLOTS,
  SCREEN_PROBE_STAGES,
  SCREEN_PROBE_TRACE_STAGES,
} from '../../raytracing/screen-probe-kernels';
import {
  packScreenProbeFrame,
  SCREEN_PROBE_FRAME_BYTES,
  type ScreenProbeFrame,
} from '../../raytracing/screen-probe-plan';

const frame: ScreenProbeFrame = {
  layout: {
    width: 4,
    height: 4,
    tilesX: 1,
    tilesY: 1,
    uniformCount: 1,
    adaptiveCapacity: 0,
    probeCount: 1,
  },
  downsample: 4,
  frameIndex: 1,
  importance: 'uniform',
  screenSteps: 0,
  thickness: 0.02,
  environment: [0, 0, 0],
  maxDistance: 10,
  shortRangeAo: 0,
  maxFrames: 10,
  sceneHistory: false,
  pixelHistory: false,
  probeHistory: false,
  worldBias: 0.1,
  cardMargin: 0.1,
  query: new Uint8Array(8),
  reprojection: undefined,
  worldSource: { traversal: 'global-sdf', expected: [36, 32, 1, 9] },
};

it('keeps private reconstruction bit3 separate from every existing history combination', () => {
  expect(SCREEN_PROBE_CURRENT_SUPPORT_MASK).toBe(8);
  expect(SCREEN_PROBE_CURRENT_SUPPORT_MASK & 7).toBe(0);
  for (let flags = 0; flags < 8; flags++) {
    const input = {
      ...frame,
      sceneHistory: (flags & 1) !== 0,
      pixelHistory: (flags & 2) !== 0,
      probeHistory: (flags & 4) !== 0,
    };
    expect(new Uint32Array(packScreenProbeFrame(input).buffer)[10]).toBe(flags);
    expect(
      new Uint32Array(
        packScreenProbeFrame({ ...input, reconstruction: 'current-support' }).buffer,
      )[10],
    ).toBe(SCREEN_PROBE_CURRENT_SUPPORT_MASK | flags);
  }
});

it('packs pixel-owned history independently of directional history and short-range AO', () => {
  const words = new Uint32Array(
    packScreenProbeFrame({
      ...frame,
      pixelHistory: true,
      probeHistory: true,
      pixelOwnedHistory: true,
      shortRangeAoMode: 'half-scalar',
    }).buffer,
  );
  expect(words[10]).toBe(6);
  expect(words[23]).toBe(4 | 128 | 256 | 512);
});

it('derives hardware current-frame eligibility only from the selected World source union', () => {
  for (let history = 0; history < 8; history++) {
    const histories = {
      sceneHistory: (history & 1) !== 0,
      pixelHistory: (history & 2) !== 0,
      probeHistory: (history & 4) !== 0,
    };
    for (const worldSource of [
      frame.worldSource,
      { traversal: 'unused' },
      { traversal: 'ray-query' },
    ] as const) {
      const input = { ...frame, ...histories, worldSource };
      const strict = new Uint32Array(packScreenProbeFrame(input).buffer);
      expect(strict[10]).toBe(history);
      const candidate = packScreenProbeFrame({ ...input, reconstruction: 'current-support' });
      expect(candidate.byteLength).toBe(SCREEN_PROBE_FRAME_BYTES);
      const words = new Uint32Array(candidate.buffer);
      expect(words[10]).toBe((worldSource.traversal === 'ray-query' ? 24 : 8) | history);
      expect((words[10] ?? 0) & 7).toBe(history);
      expect(Array.from(words.slice(44, 48))).toEqual(
        worldSource.traversal === 'global-sdf' ? [...worldSource.expected] : [0, 0, 0, 0],
      );
    }
  }
  expect(() =>
    packScreenProbeFrame({
      ...frame,
      reconstruction: 'current-support',
      worldSource: { traversal: 'global-sdf', expected: [0, 0, 0, 0] },
    }),
  ).toThrow();
});

it('composes the actual Screen and composite consumers through their production import authority', async () => {
  const builtin = await loadEngineShaderEntries();
  expect(builtin.imports['forgeax_ray::screen_reconstruction']).toBe(
    SCREEN_PROBE_RECONSTRUCTION_WGSL,
  );
  for (const visibility of [false, true]) {
    const result = await compileShader(builtin.rayScreenProbe.source, {
      id: `screen-current-support-${visibility}`,
      imports: builtin.imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
    });
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
    if (result.ok) {
      const entries = result.value.manifestEntry.entryPoints?.map((entry) => entry.name);
      for (const name of [
        'resolveProbeRays',
        'filterProbeRadiance',
        'integrateScreenProbes',
        'preintegrateScreenProbes',
        'preintegrateScatteredScreenProbes',
        'integratePreintegratedScreenProbes',
        'integrateScreenSpaceScreenProbes',
        'temporalScreenProbes',
      ])
        expect(entries).toContain(name);
    }
    const integrate = (
      await compileShader(builtin.rayScreenProbe.source, {
        id: `screen-current-hardware-integrate-${visibility}`,
        imports: builtin.imports,
        defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
        computeEntry: 'integrateScreenProbes',
      })
    ).unwrap();
    const active = integrate.reflection.boundGlobals.filter(
      (global) => (global.visibility & 4) !== 0,
    );
    expect(active.filter((global) => global.addressSpace === 'storage').length).toBeLessThanOrEqual(
      8,
    );
    const group0 = active.filter((global) => global.group === 0).map((global) => global.binding);
    const slots = SCREEN_PROBE_STAGES.integrateScreenProbes.slots.map(
      (slot) => SCREEN_PROBE_BINDINGS[slot][0],
    );
    for (const binding of group0) expect(slots).toContain(binding);
    for (const [computeEntry, roster] of [
      ['preintegrateScreenProbes', SCREEN_PROBE_IRRADIANCE_SLOTS],
      ['preintegrateScatteredScreenProbes', SCREEN_PROBE_IRRADIANCE_SLOTS],
      ['integratePreintegratedScreenProbes', SCREEN_PROBE_STAGES.integrateScreenProbes.slots],
      ['integrateScreenSpaceScreenProbes', SCREEN_PROBE_STAGES.integrateScreenProbes.slots],
    ] as const) {
      const candidate = (
        await compileShader(builtin.rayScreenProbe.source, {
          id: `screen-${computeEntry}-${visibility}`,
          imports: builtin.imports,
          defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
          computeEntry,
        })
      ).unwrap();
      const active = candidate.reflection.boundGlobals.filter(
        (global) => (global.visibility & 4) !== 0,
      );
      expect(
        active.filter((global) => global.addressSpace === 'storage').length,
      ).toBeLessThanOrEqual(8);
      if (computeEntry === 'integrateScreenSpaceScreenProbes')
        expect(active.every((global) => global.group === 0)).toBe(true);
      for (const binding of active.filter((global) => global.group === 0))
        expect(roster.map((slot) => SCREEN_PROBE_BINDINGS[slot][0])).toContain(binding.binding);
    }
    expect(active.find((global) => global.group === 0 && global.binding === 0)?.span).toBe(
      SCREEN_PROBE_FRAME_BYTES,
    );
    expect(active.find((global) => global.group === 0 && global.binding === 7)?.elementStride).toBe(
      96,
    );
    const temporal = (
      await compileShader(builtin.rayScreenProbe.source, {
        id: `screen-current-temporal-${visibility}`,
        imports: builtin.imports,
        defines: { IRRADIANCE_FIELD_VISIBILITY: visibility },
        computeEntry: 'temporalScreenProbes',
      })
    ).unwrap();
    const temporalActive = temporal.reflection.boundGlobals.filter(
      (global) => (global.visibility & 4) !== 0,
    );
    expect(
      temporalActive.filter((global) => global.addressSpace === 'storage').length,
    ).toBeLessThanOrEqual(8);
    const temporalSlots = SCREEN_PROBE_STAGES.temporalScreenProbes.slots.map(
      (slot) => SCREEN_PROBE_BINDINGS[slot][0],
    );
    for (const global of temporalActive.filter((global) => global.group === 0))
      expect(temporalSlots).toContain(global.binding);
    for (const slot of ['metaIn', 'metaOut'] as const) {
      const binding = SCREEN_PROBE_BINDINGS[slot][0];
      expect(
        temporalActive.find((global) => global.group === 0 && global.binding === binding)
          ?.elementStride,
      ).toBe(16);
    }
  }
  const composite = await compileShader(builtin.rayDiffuseComposite.source, {
    id: builtin.rayDiffuseComposite.id,
    imports: builtin.imports,
  });
  expect(composite.ok, composite.ok ? undefined : composite.error.message).toBe(true);
  if (composite.ok) {
    const entries = composite.value.manifestEntry.entryPoints?.map((entry) => entry.name);
    expect(entries).toContain('fs_ray_diffuse_reconstructed');
    expect(entries).toContain('fs_ray_diffuse_reconstructed_reflections');
  }
}, 15_000);

it('separates traced-ray lighting from hardware scatter and publishes the compact cell ABI', async () => {
  const shaderSource = new URL('../../../../shader/src/', import.meta.url);
  const builtin = await loadEngineShaderEntries((path) => {
    const normalized = path.replaceAll('\\', '/');
    const marker = '/shader/src/';
    const index = normalized.lastIndexOf(marker);
    if (index < 0) throw new Error(`Unexpected built-in shader source ${path}`);
    return readFile(new URL(normalized.slice(index + marker.length), shaderSource), 'utf8');
  });
  const compiled = (
    await compileShader(builtin.rayScreenProbe.source, {
      id: builtin.rayScreenProbe.id,
      imports: builtin.imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true },
    })
  ).unwrap();
  const generate = (
    await compileShader(builtin.rayScreenProbeGenerate.source, {
      id: builtin.rayScreenProbeGenerate.id,
      imports: builtin.imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true, IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE: true },
    })
  ).unwrap();
  const atlas = (
    await compileShader(builtin.rayScreenProbeAtlas.source, {
      id: builtin.rayScreenProbeAtlas.id,
      imports: builtin.imports,
      defines: { IRRADIANCE_FIELD_VISIBILITY: true, IRRADIANCE_FIELD_RADIANCE_ATLAS: true },
    })
  ).unwrap();
  expect(atlas.reflection.entryPoints?.map((point) => point.name)).toEqual([
    'packRadianceAtlas',
    'generateHardwareCacheProbeRays',
    'lightTraceFallbacksAtlas',
  ]);
  for (const [name, stage] of Object.entries(SCREEN_PROBE_TRACE_STAGES)) {
    const reflection =
      name === 'generateHistoryProbeRays'
        ? generate.reflection
        : name === 'packRadianceAtlas' ||
            name === 'lightTraceFallbacksAtlas' ||
            name === 'generateHardwareCacheProbeRays'
          ? atlas.reflection
          : compiled.reflection;
    const entry = reflection.entryPoints?.find((point) => point.name === name);
    expect(entry, name).toBeDefined();
    const storageCount = reflection.boundGlobals.filter(
      (global) =>
        global.addressSpace === 'storage' &&
        entry?.bindings.some(
          (binding) => binding.group === global.group && binding.binding === global.binding,
        ),
    ).length;
    expect(storageCount, name).toBeLessThanOrEqual(8);
    const group0 = entry?.bindings.filter((binding) => binding.group === 0);
    expect(
      group0
        ?.filter(
          (binding) =>
            (name !== 'lightTraceFallbacksAtlas' && name !== 'generateHardwareCacheProbeRays') ||
            binding.binding !== 38,
        )
        .map((binding) => binding.binding),
      name,
    ).toEqual(stage.slots.map((slot) => SCREEN_PROBE_BINDINGS[slot][0]).sort((a, b) => a - b));
    expect(
      entry?.bindings.some((binding) => binding.group === 1),
      name,
    ).toBe(stage.field);
  }
  expect(
    atlas.reflection.boundGlobals.find((binding) => binding.group === 0 && binding.binding === 38),
  ).toBeDefined();
  const cells = compiled.reflection.boundGlobals.filter(
    (binding) => binding.group === 0 && (binding.binding === 31 || binding.binding === 32),
  );
  expect(cells.map((binding) => binding.elementStride)).toEqual([8, 8]);
});
