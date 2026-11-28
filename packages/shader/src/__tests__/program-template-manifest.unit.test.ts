import { expect, it, vi } from 'vitest';
import { err, ok, ShaderError } from '../errors.js';
import { materialShaderSource } from '../manifest-publication.js';
import { publishShaderProgramTemplates, type ShaderProgramCompiler } from '../program-template.js';
import {
  materialShaderPreparedSourceRows,
  prepareMaterialShaderTemplateVariant,
  type ShaderTemplateManifest,
  shaderTemplateVariantEntry,
} from '../program-template-manifest.js';
import { ShaderRegistry } from '../ShaderRegistry.js';
import { findVariantByDefines, findVariantByKey, materialShaderAxes } from '../types.js';

const profile = {
  id: 'template',
  language: 'wgsl',
  profileVersion: '1',
  adapterVersion: '1',
  compilerVersion: '1',
  nagaVersion: '1',
} as const;
function wire(): ShaderTemplateManifest {
  return {
    schemaVersion: '7.0.0',
    library: publishShaderProgramTemplates(
      new Map([
        [
          'test::compute',
          {
            schemaVersion: 'shader-program-template/1',
            compilerProfile: profile,
            source: '#if RED == true\nconst color = 1u;\n#else\nconst color = 2u;\n#endif',
            imports: {},
            axes: ['RED'],
          },
        ],
      ]),
    ).unwrap(),
    entries: [
      {
        hash: 'stable-alias',
        identifier: 'test::compute',
        program: 'test::compute',
        selection: { RED: false },
      },
    ],
    materialShaders: [
      {
        identifier: 'test::compute',
        sourcePath: 'test::compute',
        paramSchema: '[]',
        program: 'test::compute',
        selection: { RED: false },
      },
    ],
  };
}
function compiler() {
  const compile = vi.fn<ShaderProgramCompiler['compile']>((_template, defines) =>
    ok({
      manifestEntry: {
        hash: `compiled-${defines.RED}`,
        wgsl: `@compute @workgroup_size(1) fn main() { let color = ${defines.RED ? 1 : 2}u; }`,
        bindings: '[]',
        glsl: undefined,
      },
      uvSetCount: 0,
    }),
  );
  return { profile, compile };
}

it('requests one exact source selection and shares the in-flight result through device forks', async () => {
  const reference = compiler();
  const compile = vi.fn<ShaderProgramCompiler['compile']>();
  const compileAsync = vi.fn(async (...args: Parameters<ShaderProgramCompiler['compile']>) =>
    reference.compile(...args),
  );
  const registry = new ShaderRegistry({
    manifestUrl: '/worker-materials',
    readText: async () => JSON.stringify(wire()),
    programCompiler: { profile, compile, compileAsync },
  });
  (await registry.loadManifest()).unwrap();
  const fork = registry.forkForDevice({} as never);
  const family = registry.materialShaderManifestEntry('test::compute');
  const receiving = fork.materialShaderManifestEntry('test::compute');
  if (family === undefined || receiving === undefined) throw new Error('Missing program family');
  const row = findVariantByDefines(family, { RED: true });
  const forkRow = findVariantByDefines(receiving, { RED: true });
  if (row === undefined || forkRow === undefined) throw new Error('Missing selected program');
  expect(prepareMaterialShaderTemplateVariant(row).unwrap()).toBe(false);
  expect(compileAsync).toHaveBeenCalledExactlyOnceWith(expect.anything(), { RED: true });
  expect(prepareMaterialShaderTemplateVariant(forkRow).unwrap()).toBe(false);
  expect(fork.resolveProgramTemplate('test::compute', { RED: true })).toMatchObject({
    ok: false,
    error: { code: 'shader-not-found', hint: expect.stringContaining('preparation is pending') },
  });
  (await fork.pendingTemplatePreparations())?.unwrap();
  expect(prepareMaterialShaderTemplateVariant(row).unwrap()).toBe(true);
  expect(materialShaderSource(row)).toBe(materialShaderSource(forkRow));
  expect(materialShaderSource(row).read()).toContain('1u');
  expect(compile).not.toHaveBeenCalled();
  expect(compileAsync).toHaveBeenCalledExactlyOnceWith(expect.anything(), { RED: true });
  expect(registry.pendingTemplatePreparations()).toBeUndefined();
});

it('admits material selections without composition and transfers their CPU recipes independently of the original registry', async () => {
  const service = compiler();
  const original = new ShaderRegistry({
    manifestUrl: '/lazy-materials',
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
  });
  (await original.loadManifest()).unwrap();
  original.installMaterialManifestTemplate('test::compute', 'RED=false').unwrap();
  expect(original.materialArtifactDeclaration('test::compute')).toEqual({
    kind: 'template',
    paramSchema: [],
  });
  expect([...original.materialShaderIdentifiers()]).toEqual(['test::compute']);
  expect(service.compile).not.toHaveBeenCalled();
  const receiving = new ShaderRegistry({ manifestUrl: undefined });
  receiving.installMaterialArtifactsFrom(original);
  expect(receiving.materialArtifactDeclaration('test::compute')?.kind).toBe('template');
  expect(service.compile).not.toHaveBeenCalled();
  expect(receiving.findMaterialArtifact('test::compute').unwrap().source).toContain('2u');
  expect(service.compile).toHaveBeenCalledTimes(1);
  expect(receiving.materialArtifactDeclaration('test::compute')?.kind).toBe('ready');
  expect(original.materialArtifactDeclaration('test::compute')?.kind).toBe('template');
  expect(original.programTemplateInspection().selections).toBe(0);
  expect(receiving.programTemplateInspection().selections).toBe(1);
  receiving.findMaterialArtifact('test::compute').unwrap();
  expect(service.compile).toHaveBeenCalledTimes(1);
});

it('registers an Engine material from its admitted schema without decoding a JSON copy', async () => {
  const base = wire();
  const schema = [{ name: 'roughness', type: 'f32', default: 0.5 }] as const;
  const program = 'test::compute';
  const [sourceMaterial] = base.materialShaders;
  if (sourceMaterial === undefined) throw new Error('Missing fixture material');
  const { paramSchema: _ignored, ...material } = sourceMaterial;
  const document = {
    ...base,
    library: {
      ...base.library,
      programs: {
        [program]: { ...base.library.programs[program], engine: { paramSchema: schema } },
      },
    },
    materialShaders: [material],
  };
  const text = JSON.stringify(document);
  const service = compiler();
  const registry = new ShaderRegistry({
    manifestUrl: '/owned-schema',
    readText: async () => text,
    programCompiler: service,
  });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    (await registry.loadManifest()).unwrap();
    expect(clone.mock.calls.some(([value]) => value?.schemaVersion === '7.0.0')).toBe(false);
  } finally {
    clone.mockRestore();
  }
  const parse = vi.spyOn(JSON, 'parse');
  try {
    registry.installMaterialManifestTemplate(program, 'RED=false').unwrap();
    expect(parse).not.toHaveBeenCalled();
    expect(registry.materialArtifactDeclaration(program)).toEqual({
      kind: 'template',
      paramSchema: schema,
    });
    expect(registry.materialShaderManifestEntry(program)?.paramSchema).toBe(JSON.stringify(schema));
    expect(service.compile).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

it('projects a selected program with its own facts without preparing the primary source', async () => {
  const service = compiler();
  const registry = new ShaderRegistry({
    manifestUrl: '/projection',
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
  });
  (await registry.loadManifest()).unwrap();
  const family = registry.materialShaderManifestEntry('test::compute');
  const entry = [...registry.entries()][0];
  if (family === undefined || entry === undefined) throw new Error('missing native declaration');
  const selected = findVariantByDefines(family, { RED: true });
  expect(findVariantByDefines(family, { UNKNOWN: true })).toBeUndefined();
  expect(findVariantByDefines(family, { UNKNOWN: false })?.defines).toEqual({ RED: true });
  if (selected === undefined) throw new Error('missing exact selection');
  const projected = shaderTemplateVariantEntry(entry, selected);
  expect(service.compile).not.toHaveBeenCalled();
  expect(projected?.wgsl).toContain('1u');
  expect(projected?.hash).toBe('compiled-true');
  expect(service.compile).toHaveBeenCalledTimes(1);
  expect(service.compile.mock.calls[0]?.[1]).toEqual({ RED: true });
});

it('returns a deferred compile failure without publishing a partial material and permits recovery', async () => {
  const service = compiler();
  const failure = new ShaderError({
    code: 'shader-compile-failed',
    message: 'invalid shader',
    expected: 'a valid selected program',
    hint: 'repair the selected source',
  });
  service.compile.mockReturnValueOnce(err(failure));
  const registry = new ShaderRegistry({
    manifestUrl: '/failure',
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
  });
  (await registry.loadManifest()).unwrap();
  registry.installMaterialManifestTemplate('test::compute', 'RED=false').unwrap();
  const failed = registry.findMaterialArtifact('test::compute');
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.error).toBe(failure);
  expect(registry.materialArtifactDeclaration('test::compute')?.kind).toBe('template');
  expect(registry.programTemplateInspection().selections).toBe(0);
  expect(registry.findMaterialArtifact('test::compute').unwrap().source).toContain('2u');
  expect(registry.materialArtifactDeclaration('test::compute')?.kind).toBe('ready');
});

it('loads source declarations atomically, selects exact keys and keeps per-device GPU modules separate', async () => {
  const service = compiler();
  const prepare = vi.fn(async () => ok(service));
  const createShaderModule = vi.fn(() => ok({} as never));
  const registry = new ShaderRegistry({
    manifestUrl: '/native',
    readText: async () => JSON.stringify(wire()),
    prepareProgramCompiler: prepare,
    device: { createShaderModule },
  });
  (await registry.loadManifest()).unwrap();
  (await registry.loadManifest()).unwrap();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(service.compile).not.toHaveBeenCalled();
  expect(registry.sourceInspection().sources).toBe(0);
  const family = registry.materialShaderManifestEntry('test::compute');
  expect(family).toBeDefined();
  if (family === undefined) throw new Error('missing admitted family');
  expect(materialShaderAxes(family)).toEqual(['RED']);
  expect(materialShaderPreparedSourceRows(family)).toEqual([]);
  expect(findVariantByKey(family, 'MISSING=false')).toBeUndefined();
  const selected = findVariantByKey(family, '');
  expect(selected).toBeDefined();
  if (selected === undefined) throw new Error('missing exact variant');
  expect(service.compile).not.toHaveBeenCalled();
  expect(materialShaderSource(selected).read()).toContain('1u');
  expect(materialShaderPreparedSourceRows(family)).toEqual([selected]);
  const requests = registry.programTemplateInspection().requests;
  expect(selected.composedWgsl).toContain('1u');
  expect(selected.composedWgsl).toContain('1u');
  expect(registry.programTemplateInspection().requests).toBe(requests);
  registry.get('stable-alias').unwrap();
  registry.get('stable-alias').unwrap();
  expect(createShaderModule).toHaveBeenCalledTimes(1);
  const childDevice = { createShaderModule: vi.fn(() => ok({} as never)) };
  const child = registry.forkForDevice(childDevice);
  const childFamily = child.materialShaderManifestEntry('test::compute');
  expect(childFamily === family).toBe(false);
  expect(childFamily).toBeDefined();
  if (childFamily === undefined) throw new Error('missing device family');
  expect(materialShaderSource(findVariantByKey(childFamily, '') ?? childFamily).read()).toContain(
    '1u',
  );
  child.get('stable-alias').unwrap();
  expect(childDevice.createShaderModule).toHaveBeenCalledTimes(1);
  expect(service.compile).toHaveBeenCalledTimes(2);
  expect(registry.programTemplateInspection().requests).toBe(requests + 1);
});

it('selects a native shader template when performance is absent', async () => {
  const service = compiler();
  const registry = new ShaderRegistry({
    manifestUrl: '/native-no-performance',
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
  });
  (await registry.loadManifest()).unwrap();
  registry.installMaterialManifestTemplate('test::compute', 'RED=false').unwrap();

  vi.stubGlobal('performance', undefined);
  try {
    expect(registry.findMaterialArtifact('test::compute').unwrap().source).toContain('2u');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps the compiled publication at a shared URL when another host loads templates', async () => {
  const manifestUrl = '/alternating-manifest';
  const compiled = { entries: [{ hash: 'compiled', wgsl: 'fn compiled() {}', bindings: '[]' }] };
  const loadCompiled = async () => {
    const registry = new ShaderRegistry({
      manifestUrl,
      readText: async () => JSON.stringify(compiled),
    });
    (await registry.loadManifest()).unwrap();
    return registry;
  };
  const original = await loadCompiled();
  const service = compiler();
  const source = new ShaderRegistry({
    manifestUrl,
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
  });
  (await source.loadManifest()).unwrap();
  expect(service.compile).not.toHaveBeenCalled();
  expect([...source.entries()].map(({ hash }) => hash)).toEqual(['stable-alias']);
  const restored = await loadCompiled();
  expect([...restored.entries()][0]).toBe([...original.entries()][0]);
  expect(service.compile).not.toHaveBeenCalled();
});

it('rejects a modified source module and non-finite JSON before starting the compiler', async () => {
  const published = wire();
  const source = Object.keys(published.library.sources)[0];
  if (source === undefined) throw new Error('Missing library source');
  const service = compiler();
  const prepare = vi.fn(async () => ok(service));
  const modified = {
    ...published,
    library: {
      ...published.library,
      sources: { ...published.library.sources, [source]: '// Different UTF-8 shader source.' },
    },
  };
  let input = JSON.stringify(modified);
  const registry = new ShaderRegistry({
    manifestUrl: '/invalid-owned-library',
    readText: async () => input,
    prepareProgramCompiler: prepare,
  });
  expect((await registry.loadManifest()).ok).toBe(false);
  expect([...registry.entries()]).toEqual([]);
  input = JSON.stringify(published).replace(
    '"compilerProfile":{',
    '"compilerProfile":{"extra":1e999,',
  );
  expect((await registry.loadManifest()).ok).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  expect([...registry.entries()]).toEqual([]);
  input = JSON.stringify(published);
  (await registry.loadManifest()).unwrap();
  expect(prepare).toHaveBeenCalledOnce();
  expect([...registry.entries()].map(({ hash }) => hash)).toEqual(['stable-alias']);
});

it('rejects broken selections before initialization and retains structured first-use compiler errors', async () => {
  const invalid = wire();
  const broken = {
    ...invalid,
    entries: [
      ...invalid.entries,
      { hash: 'bad', identifier: 'bad', program: 'absent', selection: {} },
    ],
  };
  const service = compiler();
  const prepare = vi.fn(async () => ok(service));
  const rejected = new ShaderRegistry({
    manifestUrl: '/broken',
    readText: async () => JSON.stringify(broken),
    prepareProgramCompiler: prepare,
  });
  expect((await rejected.loadManifest()).ok).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  expect([...rejected.entries()]).toEqual([]);
  expect(rejected.programTemplateInspection().templates).toBe(0);
  const failure = new ShaderError({
    code: 'shader-compile-failed',
    message: 'bad selected source',
    expected: 'valid WGSL',
    hint: 'repair source',
  });
  service.compile.mockImplementation(() => err(failure));
  const registry = new ShaderRegistry({
    manifestUrl: '/failure',
    readText: async () => JSON.stringify(wire()),
    programCompiler: service,
    device: { createShaderModule: vi.fn() },
  });
  (await registry.loadManifest()).unwrap();
  const result = registry.get('stable-alias');
  if (result.ok) throw new Error('Expected native preparation failure');
  expect(result.error).toBe(failure);
  expect(registry.sourceInspection().sources).toBe(0);
});
