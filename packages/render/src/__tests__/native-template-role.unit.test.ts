import { ok, publishShaderProgramTemplates, ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { prewarmUtilityShaders } from '../assembly/utility-shader-prewarm';
import {
  findEngineManifestEntry,
  prewarmShadowCasterModules,
} from '../assembly/webgpu-ready-shaders';

it('uses a native program declaration to find the reserved Engine role without reading unselected WGSL', async () => {
  const profile = {
    id: 'role-test',
    language: 'wgsl',
    profileVersion: '1',
    adapterVersion: '1',
    compilerVersion: '1',
    nagaVersion: '1',
  } as const;
  const library = publishShaderProgramTemplates(
    new Map([
      [
        'test::program',
        {
          schemaVersion: 'shader-program-template/1',
          compilerProfile: profile,
          source: '@compute @workgroup_size(1) fn main() {}',
          imports: {},
          axes: [],
        },
      ],
    ]),
  ).unwrap();
  const manifest = {
    schemaVersion: '7.0.0',
    library,
    entries: [
      {
        hash: 'role-source',
        identifier: 'forgeax::default-standard-pbr',
        role: 'pbr',
        program: 'test::program',
        selection: {},
      },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::default-standard-pbr',
        sourcePath: 'test::program',
        paramSchema: '[]',
        program: 'test::program',
        selection: {},
      },
    ],
  };
  const compile = vi.fn(() => {
    throw new Error('Role lookup must not compile source');
  });
  const registry = new ShaderRegistry({
    manifestUrl: '/roles',
    readText: async () => JSON.stringify(manifest),
    prepareProgramCompiler: async () => ok({ profile, compile }),
  });
  (await registry.loadManifest()).unwrap();
  const entries = [...registry.entries()];
  expect(
    findEngineManifestEntry(registry, entries, 'forgeax::default-standard-pbr') === entries[0],
  ).toBe(true);
  expect(compile).not.toHaveBeenCalled();
  expect(registry.programTemplateInspection().selections).toBe(0);
});

it('discovers a native utility by identity without preparing unrelated source or reflection', async () => {
  const profile = {
    id: 'utility',
    language: 'wgsl',
    profileVersion: '1',
    adapterVersion: '1',
    compilerVersion: '1',
    nagaVersion: '1',
  } as const;
  const templates = new Map(
    ['unused', 'selected'].map((id) => [
      id,
      {
        schemaVersion: 'shader-program-template/1' as const,
        compilerProfile: profile,
        source: `@compute @workgroup_size(1) fn ${id}() {}`,
        imports: {},
        axes: [],
      },
    ]),
  );
  const compile = vi.fn((template: { readonly source: string }) => {
    if (template.source.includes('unused')) throw new Error('Unrelated utility was prepared');
    return ok({
      manifestEntry: { hash: 'selected', wgsl: template.source, glsl: undefined, bindings: '[]' },
      uvSetCount: 0,
    });
  });
  const manifest = {
    schemaVersion: '7.0.0',
    library: publishShaderProgramTemplates(templates).unwrap(),
    entries: ['unused', 'selected'].map((identifier) => ({
      identifier,
      hash: identifier,
      program: identifier,
      selection: {},
    })),
    materialShaders: [],
  };
  const registry = new ShaderRegistry({
    manifestUrl: '/utilities',
    readText: async () => JSON.stringify(manifest),
    programCompiler: { profile, compile },
  });
  (await registry.loadManifest()).unwrap();
  const deviceCompile = vi.fn(async () => ({}) as never);
  const sources = await prewarmUtilityShaders(
    'test',
    [['stage', 'selected', 'selected', 'selected']],
    [...registry.entries()],
    deviceCompile,
    vi.fn(),
  );
  expect(sources?.stage.read()).toContain('fn selected');
  expect(compile).toHaveBeenCalledTimes(1);
  expect(deviceCompile).toHaveBeenCalledTimes(1);
  expect(registry.programTemplateInspection().selections).toBe(1);
});

it('prepares the boot shadow program once and leaves geometry and coverage selections for their actual draw', async () => {
  const profile = {
    id: 'shadow',
    language: 'wgsl',
    profileVersion: '1',
    adapterVersion: '1',
    compilerVersion: '1',
    nagaVersion: '1',
  } as const;
  const source = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }';
  const library = publishShaderProgramTemplates(
    new Map([
      [
        'shadow',
        {
          schemaVersion: 'shader-program-template/1',
          compilerProfile: profile,
          source,
          imports: {},
          axes: ['STORAGE_BUFFER_AVAILABLE', 'SKINNING_DISABLED', 'ALPHA_MASK'],
        },
      ],
    ]),
  ).unwrap();
  const selection = { STORAGE_BUFFER_AVAILABLE: true, SKINNING_DISABLED: true, ALPHA_MASK: false };
  const manifest = {
    schemaVersion: '7.0.0',
    library,
    entries: [
      {
        hash: 'shadow',
        identifier: 'forgeax::default-shadow-caster',
        role: 'shadowCaster',
        program: 'shadow',
        selection,
      },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::default-shadow-caster',
        sourcePath: 'shadow',
        paramSchema: '[]',
        program: 'shadow',
        selection,
      },
    ],
  };
  const compose = vi.fn(() =>
    ok({
      manifestEntry: { hash: 'shadow', wgsl: source, glsl: undefined, bindings: '[]' },
      uvSetCount: 0,
    }),
  );
  const registry = new ShaderRegistry({
    manifestUrl: '/shadow',
    readText: async () => JSON.stringify(manifest),
    programCompiler: { profile, compile: compose },
  });
  (await registry.loadManifest()).unwrap();
  const compile = vi.fn(async () => ({}) as never);
  const seed = vi.fn();
  await prewarmShadowCasterModules(
    registry,
    compile,
    seed,
    {
      storageBuffer: true,
      atmosphere: true,
      webgl2Downlevel: false,
      extendedLighting: true,
      directionalPcss: true,
      projector: true,
    },
    [...registry.entries()][0],
  );
  expect(compose).toHaveBeenCalledTimes(1);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(seed).toHaveBeenCalledTimes(1);
  expect(registry.programTemplateInspection().selections).toBe(1);
});
