import { rhi } from '@forgeax/engine-rhi-null';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleStandardPbrArtifact,
  type MaterialShaderArtifactRequest,
  resolveMaterialShaderArtifact,
} from '../assembly/material/assembly';

import { ADMIT_EVERY_VARIANT } from '../assembly/shader-prewarm-policy';
import { buildGpuDrivenPbrReadyModules } from '../assembly/webgpu-pbr-ready';

const source = '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4(0.0); }';

function manifestLookup<T extends { identifier: string }>(entries: readonly T[]) {
  return (identifier: string) => entries.find((entry) => entry.identifier === identifier);
}

describe('Standard PBR artifact assembly', () => {
  it('keeps every closed request combination isolated while reusing its own artifact', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const receipt = createStandardPbrArtifactReceipt();
    registry.installMaterialArtifact('game::surface', { source, paramSchema: [], receipt });
    const axes: readonly (readonly MaterialShaderArtifactRequest[])[] = [
      [{}, { vertexColorAvailable: false }, { vertexColorAvailable: true }],
      [{}, { clustered: false }, { clustered: true }],
      [{}, { probeBlend: false }, { probeBlend: true }],
      [{}, { reflectionFallback: false }, { reflectionFallback: true }],
      [{}, { visibleSurface: false }, { visibleSurface: true }],
      [{}, { deformation: 'rigid' }, { deformation: 'skin' }],
      [{}, { address: 'direct' }, { address: 'scene-index' }],
      [{}, { pass: 'forward' }, { pass: 'shadow' }, { pass: 'depth' }],
    ];
    const requests = axes.reduce<MaterialShaderArtifactRequest[]>(
      (requests, variants) =>
        requests.flatMap((request) => variants.map((axis) => ({ ...request, ...axis }))),
      [{}],
    );
    const artifacts = requests.map((request) => {
      const artifact = resolveMaterialShaderArtifact('game::surface', registry, request);
      expect(artifact?.pass).toBe(request.pass ?? 'forward');
      expect(artifact?.vertexEntry).toBe(
        request.address === undefined
          ? undefined
          : request.address === 'direct'
            ? receipt.directEntry
            : receipt.sceneIndexEntry,
      );
      expect(resolveMaterialShaderArtifact('game::surface', registry, { ...request })).toBe(
        artifact,
      );
      return artifact;
    });
    expect(artifacts).toHaveLength(8748);
    expect(new Set(artifacts).size).toBe(artifacts.length);
  });

  it('separates arbitrary identifier and variant strings even for one shared entry', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    registry.installMaterialArtifact('game::shared', {
      source,
      paramSchema: [],
      receipt: createStandardPbrArtifactReceipt(),
    });
    const shared = registry.findMaterialArtifact('game::shared');
    const owner = {
      findMaterialArtifact: () => shared,
      materialProgram: registry.materialProgram.bind(registry),
      materialShaderManifestEntry: () => undefined,
    };
    const identifiers = ['a', 'a:b', 'a|b', '3:a0:-0:::', 'a\u0000b', '\ud83d\ude80'];
    const variants = [
      undefined,
      '',
      '-',
      '0:',
      ':b',
      'b:c',
      '|b',
      '[null,"x"]',
      '\u0000',
      '\ud83d\ude80',
    ];
    const artifacts = identifiers.flatMap((identifier) =>
      variants.map((variantSet) => {
        const request = variantSet === undefined ? {} : { variantSet };
        const artifact = resolveMaterialShaderArtifact(identifier, owner, request);
        expect(artifact?.material).toBe(identifier);
        expect(artifact?.variantSet).toBe(variantSet);
        expect(resolveMaterialShaderArtifact(identifier, owner, { ...request })).toBe(artifact);
        return artifact;
      }),
    );
    expect(new Set(artifacts).size).toBe(identifiers.length * variants.length);
  });

  it('resolves repeated material requests without enumerating unrelated manifest rows', async () => {
    const receipt = createStandardPbrArtifactReceipt();
    const materialShaders = ['game::unrelated', 'game::surface'].map((identifier) => ({
      identifier,
      sourcePath: 'surface.wgsl',
      composedWgsl: source,
      paramSchema: '[]',
      variants: [],
    }));
    const registry = new ShaderRegistry({
      manifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [], materialShaders }))}`,
    });
    expect((await registry.loadManifest()).ok).toBe(true);
    registry.installMaterialArtifact('game::surface', { source, paramSchema: [], receipt });
    const enumerate = vi.spyOn(registry, 'materialShaderManifestEntries');
    const first = resolveMaterialShaderArtifact('game::surface', registry);
    expect(first?.program.source).toBe(source);
    expect(resolveMaterialShaderArtifact('game::surface', registry)).toBe(first);
    expect(enumerate).not.toHaveBeenCalled();
  });

  it('observes installation, late manifest admission and replacement registry ownership', async () => {
    const receipt = createStandardPbrArtifactReceipt();
    const identifier = 'game::surface';
    const manifest = {
      entries: [],
      materialShaders: [
        {
          identifier,
          sourcePath: 'surface.wgsl',
          composedWgsl: source,
          paramSchema: '[]',
          variants: [
            {
              definesKey: 'VISIBLE_SURFACE_AVAILABLE=false',
              defines: { VISIBLE_SURFACE_AVAILABLE: false },
              composedWgsl: `${source}\n// admitted`,
              receipt,
            },
          ],
        },
      ],
    };
    const registry = new ShaderRegistry({
      manifestUrl: `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`,
    });
    const resolve = (owner: ShaderRegistry, visibleSurface = false) =>
      resolveMaterialShaderArtifact(identifier, owner, { visibleSurface });
    expect(resolve(registry)).toBeUndefined();
    registry.installMaterialArtifact(identifier, { source, paramSchema: [], receipt });
    const initial = resolve(registry);
    expect(initial?.program.source).toBe(source);
    expect((await registry.loadManifest()).ok).toBe(true);
    const admitted = resolve(registry);
    expect(admitted?.program.source).toContain('// admitted');
    expect(admitted).not.toBe(initial);
    expect(resolve(registry)).toBe(admitted);
    expect(resolve(registry, true)).toBeUndefined();

    const replacement = registry.forkForDevice({
      createShaderModule: () => {
        throw new Error('CPU artifact lookup must not create a GPU module');
      },
    });
    expect(resolve(replacement)).toBeUndefined();
    replacement.installMaterialArtifact(identifier, { source, paramSchema: [], receipt });
    const recovered = resolve(replacement);
    expect(recovered?.program).toBe(admitted?.program);
    expect(recovered).not.toBe(admitted);
    expect(resolve(replacement, true)).toBeUndefined();

    const independent = new ShaderRegistry({ manifestUrl: undefined });
    independent.installMaterialArtifact(identifier, { source, paramSchema: [], receipt });
    expect(resolve(independent)?.program.source).toBe(source);
    expect(resolve(registry)).toBe(admitted);
  });

  it.each([
    false,
    true,
  ])('keeps optional skin warmup only when immediate modules are unavailable (%s)', async (immediate) => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const labels: string[] = [];
    const seeds = new Map<string, unknown>();
    const input = {
      registry,
      device,
      storageBufferCapable: false,
      asyncCreateShaderModule: async (
        owner: typeof device,
        descriptor: { code: string; label?: string | undefined },
      ) => {
        labels.push(descriptor.label ?? '');
        return rhi.createShaderModule(owner, descriptor);
      },
      immediateCreateShaderModule: immediate
        ? () => {
            throw new Error('unused variant');
          }
        : undefined,
      pbrSkinEntry: { hash: 'skin', wgsl: source, glsl: '', bindings: '[]' },
      pbrManifestEntry: undefined,
      pbrSkinManifestEntry: {
        identifier: 'forgeax::pbr-skin',
        sourcePath: 'skin.wgsl',
        composedWgsl: source,
        paramSchema: '[]',
        variants: [
          {
            definesKey: 'optional',
            defines: { STORAGE_BUFFER_AVAILABLE: false },
            composedWgsl: `${source}\n// optional skin`,
          },
        ],
      },
      extendedLightingShaderAvailable: false,
      directionalPcssAvailable: false,
      projectorAvailable: false,
      seedShaderModule: (label: string, module: unknown) => seeds.set(label, module),
      admitsVariant: ADMIT_EVERY_VARIANT,
    };
    const ready = await buildGpuDrivenPbrReadyModules(input);
    expect(seeds.get('module-forgeax::pbr-skin')).toBe(ready.pbrSkinModule);
    expect(labels).toEqual(
      immediate ? ['pbr-skin'] : ['pbr-skin', 'module-forgeax::pbr-skin#optional'],
    );
  });

  it('reuses program facts when GPU prewarming rebuilds modules for another device', async () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const program = registry.materialProgram(source);
    const replacement = registry.forkForDevice({
      createShaderModule: () => {
        throw new Error('prewarming must use the explicit backend');
      },
    });
    const modules = [];
    const seeds: Map<string, unknown>[] = [];
    for (const owner of [registry, replacement]) {
      const seeded = new Map<string, unknown>();
      seeds.push(seeded);
      const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
      const ready = await buildGpuDrivenPbrReadyModules({
        registry: owner,
        device,
        storageBufferCapable: true,
        asyncCreateShaderModule: rhi.createShaderModule,
        pbrSkinEntry: undefined,
        pbrSkinManifestEntry: undefined,
        pbrManifestEntry: {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'standard.wgsl',
          composedWgsl: source,
          paramSchema: '[]',
          variants: [
            {
              definesKey: 'scene',
              defines: { STORAGE_BUFFER_AVAILABLE: true, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
              composedWgsl: source,
            },
          ],
        },
        extendedLightingShaderAvailable: false,
        directionalPcssAvailable: false,
        projectorAvailable: false,
        seedShaderModule: (label, module) => seeded.set(label, module),
        admitsVariant: ADMIT_EVERY_VARIANT,
      });
      const prepared = ready.gpuDrivenPbrPrograms.get('forgeax::default-standard-pbr|color=false');
      expect(prepared?.artifact.program).toBe(program);
      // The GPU-driven raster adapter requests the variant through its lazy
      // material label; a missing seed leaves the first frame pending.
      expect(seeded.get('module-forgeax::default-standard-pbr#scene')).toBe(prepared?.module);
      modules.push(prepared?.module);
    }
    expect(modules[0]).toBeDefined();
    expect(modules[1]).not.toBe(modules[0]);
  });

  it.each([
    'direct',
    'scene-index',
  ] as const)('selects the requested %s address instead of the all-true shadow variant', (address) => {
    const receipt = createStandardPbrArtifactReceipt(false, true);
    const variants = [
      { available: true, explicit: true, key: '' },
      { available: true, explicit: false, key: 'scene' },
      { available: false, explicit: false, key: 'direct' },
    ].map(({ available, explicit, key }) => ({
      definesKey: key,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        SKINNING_DISABLED: true,
        VERTEX_COLOR_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: available,
        GPU_DRIVEN_SCENE_INDEX_EXPLICIT: explicit,
      },
      composedWgsl: key,
      receipt,
    }));
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: { program: createMaterialShaderProgram(source), source, paramSchema: [], receipt },
      }),
      materialShaderManifestEntry: manifestLookup([
        {
          identifier: 'forgeax::default-shadow-caster',
          variants,
        },
      ]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      address,
      pass: 'shadow',
      deformation: 'rigid',
      vertexColorAvailable: true,
    });
    expect(artifact?.program.source).toBe(address === 'scene-index' ? 'scene' : 'direct');
  });

  it('keeps visible-surface selection distinct in the artifact cache', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const entry = {
      program: createMaterialShaderProgram(source),
      source,
      paramSchema: [],
      receipt,
    };
    const variants = [false, true].map((visible) => ({
      definesKey: `VISIBLE_SURFACE_AVAILABLE=${visible}`,
      defines: { VISIBLE_SURFACE_AVAILABLE: visible },
      composedWgsl: `${source}\n// visible ${visible}`,
      receipt,
    }));
    const manifest = { identifier: 'authored', variants };
    const registry = {
      findMaterialArtifact: () => ({ ok: true, value: entry }),
      materialProgram: createMaterialShaderProgram,
      materialShaderManifestEntry: manifestLookup([manifest]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const ordinary = resolveMaterialShaderArtifact('authored', registry, { visibleSurface: false });
    const visible = resolveMaterialShaderArtifact('authored', registry, { visibleSurface: true });
    expect(ordinary?.program.source).toContain('visible false');
    expect(visible?.program.source).toContain('visible true');
    expect(resolveMaterialShaderArtifact('authored', registry, { visibleSurface: false })).toBe(
      ordinary,
    );
  });

  it('records the selected fallback output even when the all-true variant key is empty', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const entry = {
      program: createMaterialShaderProgram(source),
      source,
      paramSchema: [],
      receipt,
    };
    const variants = [
      {
        definesKey: '',
        defines: { REFLECTION_FALLBACK_AVAILABLE: true },
        composedWgsl: `${source}\n// fallback output`,
        receipt,
      },
      {
        definesKey: 'REFLECTION_FALLBACK_AVAILABLE=false',
        defines: { REFLECTION_FALLBACK_AVAILABLE: false },
        composedWgsl: `${source}\n// no fallback output`,
        receipt,
      },
    ];
    const registry = {
      findMaterialArtifact: () => ({ ok: true, value: entry }),
      materialProgram: createMaterialShaderProgram,
      materialShaderManifestEntry: manifestLookup([{ identifier: 'authored', variants }]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];

    const withOutput = resolveMaterialShaderArtifact('authored', registry, {
      reflectionFallback: true,
    });
    const withoutOutput = resolveMaterialShaderArtifact('authored', registry, {
      reflectionFallback: false,
    });

    expect(withOutput?.variantSet).toBe('');
    expect(withOutput?.reflectionFallbackOutputAvailable).toBe(true);
    expect(withoutOutput?.reflectionFallbackOutputAvailable).toBe(false);
  });

  it('assembles the rigid registry entry from one receipt producer', () => {
    const artifact = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr',
      createMaterialShaderProgram(source),
    );
    const receipt = createStandardPbrArtifactReceipt();

    expect(artifact).toBeDefined();
    expect(artifact?.material).toBe('forgeax::default-standard-pbr');
    expect(artifact?.program.source).toBe(source);
    expect(artifact?.program).toEqual(createMaterialShaderProgram(source));
    expect(artifact?.layoutIdentity).toBe(receipt.reflection.layoutIdentity);
    expect(artifact?.receipt).toEqual(receipt);
    expect(artifact?.vertexInputs).toEqual(
      receipt.vertexInputs.map(({ semantic, location, format }) => ({
        semantic,
        location,
        format,
      })),
    );
  });

  it('retains shader UV aliases beyond the minimum geometry receipt after recovery', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const wgsl = `struct VsIn { @location(2) uv: vec2<f32>, @location(12) uv7: vec2<f32>, }
@vertex fn vs_scene_index(input: VsIn) -> @builtin(position) vec4<f32> { return vec4(input.uv, 0., 1.); }`;
    const artifact = resolveMaterialShaderArtifact(
      'forgeax::default-standard-pbr',
      {
        materialShaderManifestEntry: () => undefined,
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: () => ({
          ok: true,
          value: {
            program: createMaterialShaderProgram(wgsl),
            source: wgsl,
            paramSchema: [],
            receipt,
          },
        }),
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1],
      { address: 'scene-index' },
    );
    expect(artifact?.uvSetCount).toBe(8);
    expect(artifact?.receipt).toBe(receipt);
  });

  it('adds the skin palette receipt facts for the skinned registry entry', () => {
    const artifact = assembleStandardPbrArtifact(
      'forgeax::default-standard-pbr-skin',
      createMaterialShaderProgram(source),
    );
    const receipt = createStandardPbrArtifactReceipt(true);

    expect(artifact?.receipt).toEqual(receipt);
    expect(artifact?.receipt?.skinPaletteAddress).toEqual({ group: 2, binding: 1, stride: 64 });
    expect(artifact?.vertexInputs).toHaveLength(receipt.vertexInputs.length);
  });

  it('rejects unsupported shader identifiers without manufacturing an artifact', () => {
    expect(
      assembleStandardPbrArtifact('forgeax::default-unlit', createMaterialShaderProgram(source)),
    ).toBeUndefined();
  });

  it('fails closed when a geometry-specific color fact has no matching producer receipt', () => {
    expect(
      assembleStandardPbrArtifact(
        'forgeax::default-standard-pbr',
        { program: createMaterialShaderProgram(source), source, paramSchema: [] },
        { vertexColorAvailable: true },
      ),
    ).toBeUndefined();
    expect(
      assembleStandardPbrArtifact(
        'forgeax::default-standard-pbr',
        {
          program: createMaterialShaderProgram(source),
          source,
          paramSchema: [],
          receipt: createStandardPbrArtifactReceipt(),
        },
        { vertexColorAvailable: true },
      ),
    ).toBeUndefined();
  });

  it.each([
    'direct',
    'scene-index',
  ] as const)('keeps an exact published program that does not consume extra COLOR_0 (%s)', (address) => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const key = 'sha256:plain-material-program';
    const receipt = createStandardPbrArtifactReceipt();
    registry.installMaterialArtifact(key, { source, paramSchema: [], receipt });
    const registered = registry.findMaterialArtifact(key).unwrap();
    const artifact = resolveMaterialShaderArtifact(key, registry, {
      address,
      pass: 'forward',
      vertexColorAvailable: true,
    });
    expect(artifact?.program.source).toBe(source);
    expect(artifact?.program).toBe(registered.program);
    expect(artifact?.receipt).toBe(registered.receipt);
    expect(artifact?.receipt).not.toBe(receipt);
    expect(artifact?.receipt).toEqual(receipt);
    expect(Object.isFrozen(artifact?.receipt)).toBe(true);
    expect(artifact?.vertexEntry).toBe(
      address === 'scene-index' ? receipt.sceneIndexEntry : receipt.directEntry,
    );
    expect(artifact?.receipt?.vertexInputs.some((input) => input.semantic === 'color')).toBe(false);
  });

  it('rejects an exact published program whose required COLOR_0 is absent', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const key = 'sha256:colored-material-program';
    registry.installMaterialArtifact(key, {
      source,
      paramSchema: [],
      receipt: createStandardPbrArtifactReceipt(false, true),
    });
    expect(
      resolveMaterialShaderArtifact(key, registry, {
        address: 'scene-index',
        vertexColorAvailable: false,
      }),
    ).toBeUndefined();
  });

  it('keeps an exact published program without a producer receipt unavailable', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const key = 'sha256:unreceipted-material-program';
    registry.installMaterialArtifact(key, { source, paramSchema: [] });
    expect(
      resolveMaterialShaderArtifact(key, registry, {
        address: 'scene-index',
        vertexColorAvailable: true,
      }),
    ).toBeUndefined();
  });

  it('selects the published COLOR_0 ABI and keeps colored/plain identities apart', () => {
    const plain = createStandardPbrArtifactReceipt();
    const colored = createStandardPbrArtifactReceipt(false, true);
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: {
          program: createMaterialShaderProgram('fallback'),
          source: 'fallback',
          paramSchema: [],
          receipt: plain,
        },
      }),
      materialShaderManifestEntry: manifestLookup([
        {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'default-standard-pbr.wgsl',
          composedWgsl: 'fallback',
          paramSchema: '[]',
          variants: [
            {
              definesKey: 'VERTEX_COLOR_AVAILABLE=false',
              defines: { VERTEX_COLOR_AVAILABLE: false },
              composedWgsl: 'plain-variant',
              receipt: plain,
            },
            {
              definesKey: 'VERTEX_COLOR_AVAILABLE=true',
              defines: { VERTEX_COLOR_AVAILABLE: true },
              composedWgsl: 'colored-variant',
              receipt: colored,
            },
          ],
        },
      ]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];

    const coloredArtifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      vertexColorAvailable: true,
    });
    const plainArtifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      vertexColorAvailable: false,
    });

    expect(coloredArtifact?.program.source).toBe('colored-variant');
    expect(coloredArtifact?.receipt).toEqual(colored);
    expect(coloredArtifact?.receipt?.vertexInputs).toContainEqual({
      semantic: 'color',
      location: 13,
      format: 'float32x4',
    });
    expect(plainArtifact?.program.source).toBe('plain-variant');
    expect(plainArtifact?.receipt).toEqual(plain);
    expect(plainArtifact?.receipt?.vertexInputs).not.toContainEqual(
      expect.objectContaining({ semantic: 'color' }),
    );
    expect(coloredArtifact?.receipt?.receiptIdentity).not.toBe(
      plainArtifact?.receipt?.receiptIdentity,
    );

    const custom = resolveMaterialShaderArtifact(
      'game::custom-surface',
      {
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: () => ({
          ok: true as const,
          value: {
            program: createMaterialShaderProgram('custom-fallback'),
            source: 'custom-fallback',
            paramSchema: [],
            receipt: plain,
          },
        }),
        materialShaderManifestEntry: manifestLookup([
          {
            identifier: 'game::custom-surface',
            sourcePath: 'custom.wgsl',
            composedWgsl: 'custom-fallback',
            paramSchema: '[]',
            variants: [
              {
                definesKey: 'VERTEX_COLOR_AVAILABLE=true',
                defines: { VERTEX_COLOR_AVAILABLE: true },
                composedWgsl: 'custom-colored',
                receipt: colored,
              },
            ],
          },
        ]),
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1],
      { vertexColorAvailable: true },
    );
    expect(custom?.program.source).toBe('custom-colored');
    expect(custom?.program).toEqual(createMaterialShaderProgram('custom-colored'));
    expect(custom?.receipt).toEqual(colored);
  });

  it('resolves a topology projection against the producer complete variant key', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({
        ok: true as const,
        value: {
          program: createMaterialShaderProgram('boot-direct'),
          source: 'boot-direct',
          paramSchema: [],
          receipt,
        },
      }),
      materialShaderManifestEntry: manifestLookup([
        {
          identifier: 'forgeax::default-standard-pbr',
          sourcePath: 'default-standard-pbr.wgsl',
          composedWgsl: 'boot-direct',
          paramSchema: '[]',
          variants: [
            {
              definesKey:
                'CLUSTER_FORWARD_AVAILABLE=false+GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true+PROBE_BLEND_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
              defines: {
                CLUSTER_FORWARD_AVAILABLE: false,
                GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
                PROBE_BLEND_AVAILABLE: false,
                STORAGE_BUFFER_AVAILABLE: true,
                VERTEX_COLOR_AVAILABLE: false,
              },
              composedWgsl: 'scene-index',
              receipt,
            },
          ],
        },
      ]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
      address: 'scene-index',
      pass: 'forward',
      vertexColorAvailable: false,
      variantSet:
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false',
    });
    expect(artifact?.program.source).toBe('scene-index');
    expect(artifact?.receipt).toEqual(receipt);
  });

  it('keeps probe-enabled scene programs distinct in the publication cache', () => {
    const receipt = createStandardPbrArtifactReceipt();
    const entry = {
      program: createMaterialShaderProgram('boot-direct'),
      source: 'boot-direct',
      paramSchema: [],
      receipt,
    };
    const manifest = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: entry.source,
      paramSchema: '[]',
      variants: [false, true].map((probeBlend) => ({
        definesKey: `PROBE_BLEND_AVAILABLE=${probeBlend}`,
        defines: {
          PROBE_BLEND_AVAILABLE: probeBlend,
          STORAGE_BUFFER_AVAILABLE: true,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        },
        composedWgsl: probeBlend ? 'scene-probe' : 'scene-sky',
        receipt,
      })),
    };
    const shader = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({ ok: true as const, value: entry }),
      materialShaderManifestEntry: manifestLookup([manifest]),
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    for (const probeBlend of [false, true, false, true]) {
      const artifact = resolveMaterialShaderArtifact('forgeax::default-standard-pbr', shader, {
        address: 'scene-index',
        pass: 'forward',
        probeBlend,
      });
      expect(artifact?.program.source).toBe(probeBlend ? 'scene-probe' : 'scene-sky');
      expect(artifact?.variantSet).toBe(`PROBE_BLEND_AVAILABLE=${probeBlend}`);
    }
  });

  it('routes built-in Standard shadow requests through the shadow-caster artifact', () => {
    const rigidPlain = createStandardPbrArtifactReceipt();
    const rigidColor = createStandardPbrArtifactReceipt(false, true);
    const skinPlain = createStandardPbrArtifactReceipt(true);
    const shadowEntry = {
      identifier: 'forgeax::default-shadow-caster',
      sourcePath: 'default-shadow-caster.wgsl',
      composedWgsl: 'shadow-primary',
      paramSchema: '[]',
      variants: [
        {
          definesKey: 'SKINNING_DISABLED=true+VERTEX_COLOR_AVAILABLE=false',
          defines: { SKINNING_DISABLED: true, VERTEX_COLOR_AVAILABLE: false },
          composedWgsl: 'shadow-rigid-plain-with-fs_shadow',
          receipt: rigidPlain,
        },
        {
          definesKey: 'SKINNING_DISABLED=true+VERTEX_COLOR_AVAILABLE=true',
          defines: { SKINNING_DISABLED: true, VERTEX_COLOR_AVAILABLE: true },
          composedWgsl: 'shadow-rigid-color-with-fs_shadow',
          receipt: rigidColor,
        },
        {
          definesKey: 'SKINNING_DISABLED=false+VERTEX_COLOR_AVAILABLE=false',
          defines: { SKINNING_DISABLED: false, VERTEX_COLOR_AVAILABLE: false },
          composedWgsl: 'shadow-skin-plain-with-fs_shadow',
          receipt: skinPlain,
        },
      ],
    };
    const standardEntry = {
      identifier: 'forgeax::default-standard-pbr',
      sourcePath: 'default-standard-pbr.wgsl',
      composedWgsl: 'standard-forward-without-fs_shadow',
      paramSchema: '[]',
      variants: [],
    };

    for (const entries of [
      [standardEntry, shadowEntry],
      [shadowEntry, standardEntry],
    ]) {
      const shader = {
        materialProgram: createMaterialShaderProgram,
        findMaterialArtifact: (identifier: string) => ({
          ok: true as const,
          value: {
            program: createMaterialShaderProgram(
              identifier === 'forgeax::default-shadow-caster' ? 'shadow-primary' : 'standard',
            ),
            source: identifier === 'forgeax::default-shadow-caster' ? 'shadow-primary' : 'standard',
            paramSchema: [],
            receipt: rigidPlain,
          },
        }),
        materialShaderManifestEntry: manifestLookup(entries),
      } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];

      const rigidColorArtifact = resolveMaterialShaderArtifact(
        'forgeax::default-standard-pbr',
        shader,
        {
          address: 'scene-index',
          deformation: 'rigid',
          pass: 'shadow',
          vertexColorAvailable: true,
        },
      );
      const skinPlainArtifact = resolveMaterialShaderArtifact(
        'forgeax::default-standard-pbr-skin',
        shader,
        { address: 'scene-index', deformation: 'skin', pass: 'shadow' },
      );

      expect(rigidColorArtifact?.material).toBe('forgeax::default-shadow-caster');
      expect(rigidColorArtifact?.fragmentEntry).toBe('fs_shadow');
      expect(rigidColorArtifact?.program.source).toBe('shadow-rigid-color-with-fs_shadow');
      expect(rigidColorArtifact?.receipt).toEqual(rigidColor);
      expect(skinPlainArtifact?.material).toBe('forgeax::default-shadow-caster');
      expect(skinPlainArtifact?.program.source).toBe('shadow-skin-plain-with-fs_shadow');
      expect(skinPlainArtifact?.receipt).toEqual(skinPlain);
    }
  });
  it('reuses immutable publications and invalidates changed registry or manifest identities', () => {
    const receipt = createStandardPbrArtifactReceipt();
    let entry = { program: createMaterialShaderProgram(source), source, paramSchema: [], receipt };
    let manifest = {
      identifier: 'game::surface',
      sourcePath: 'surface.wgsl',
      composedWgsl: source,
      paramSchema: '[]',
      variants: [{ definesKey: '', defines: {}, composedWgsl: 'first', receipt }],
    };
    const registry = {
      materialProgram: createMaterialShaderProgram,
      findMaterialArtifact: () => ({ ok: true, value: entry }),
      materialShaderManifestEntry: (identifier: string) =>
        manifest.identifier === identifier ? manifest : undefined,
    } as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
    const resolve = () =>
      resolveMaterialShaderArtifact('game::surface', registry, { address: 'scene-index' });
    const first = resolve();
    expect(first?.program.source).toBe('first');
    expect(resolve()).toBe(first);
    expect(
      resolveMaterialShaderArtifact('game::surface', registry, { address: 'direct' })?.vertexEntry,
    ).toBe(receipt.directEntry);
    manifest = {
      ...manifest,
      variants: [{ definesKey: '', defines: {}, receipt, composedWgsl: 'second' }],
    };
    const second = resolve();
    expect(second).not.toBe(first);
    expect(second?.program.source).toBe('second');
    expect(resolve()).toBe(second);
    entry = { ...entry };
    expect(resolve()).not.toBe(second);
  });
});
