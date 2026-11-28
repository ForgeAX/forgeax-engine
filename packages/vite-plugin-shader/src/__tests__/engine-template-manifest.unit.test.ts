import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import {
  admitShaderTemplateManifest,
  findVariantByKey,
  materialShaderAxes,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { buildEngineShaderManifest, buildEngineShaderTemplateManifest } from '../index.js';
import { loadSharedEngineShaderTemplates } from '../shared-engine-inputs.js';

let defaultTemplates: ReturnType<typeof buildEngineShaderTemplateManifest> | undefined;

function defaultEngineTemplates() {
  defaultTemplates ??= buildEngineShaderTemplateManifest();
  return defaultTemplates;
}

it('publishes one prepared layout and compiles raster variants only when requested', async () => {
  const wire = await defaultEngineTemplates();
  expect(wire.schemaVersion).toBe('7.0.0');
  expect(wire.entries.length).toBeGreaterThan(50);
  expect(Object.keys(wire.library.programs).length).toBe(wire.entries.length);
  expect(JSON.stringify(wire)).not.toContain('composedWgsl');
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  const compile = vi.fn(compiler.compile);
  const registry = new ShaderRegistry({
    manifestUrl: '/templates',
    readText: async () => JSON.stringify(wire),
    programCompiler: { ...compiler, compile },
  });
  (await registry.loadManifest()).unwrap();
  const probe = wire.entries.find((entry) => entry.preparedReflection !== undefined);
  if (probe?.preparedReflection === undefined)
    throw new Error('Missing published Cluster reflection');
  expect(probe.identifier).toBe('forgeax_standard::cluster_layout_probe');
  expect(wire.entries.filter((row) => row.preparedReflection !== undefined)).toHaveLength(1);
  const published = Array.from(registry.entries()).find((entry) => entry.hash === probe.hash);
  expect(published?.reflection).toEqual(probe.preparedReflection.reflection);
  expect(published?.sourceDigest).toBe(probe.preparedReflection.sourceDigest);
  expect(published?.compilerProfile).toEqual(wire.library.compilerProfile);
  expect(registry.programTemplateInspection().selections).toBe(0);
  expect(compile).not.toHaveBeenCalled();
  expect(
    admitShaderTemplateManifest({
      ...wire,
      entries: wire.entries.map((row) =>
        row === probe
          ? { ...row, preparedReflection: { ...probe.preparedReflection, selectionKey: 'wrong' } }
          : row,
      ),
    }).ok,
  ).toBe(false);
  const family = registry.materialShaderManifestEntry('forgeax::default-standard-pbr');
  if (family === undefined) throw new Error('missing native Standard source');
  expect(materialShaderAxes(family)).toContain('CLUSTER_FORWARD_AVAILABLE');
  expect(
    JSON.parse(family.paramSchema).some(
      (parameter: { name: string }) => parameter.name === 'baseColor',
    ),
  ).toBe(true);
  const declared = wire.materialShaders.find((row) => row.identifier === family.identifier);
  if (declared === undefined) throw new Error('missing Standard declaration');
  const fields = Object.entries(declared.selection).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const key = fields.every(([, value]) => value)
    ? ''
    : fields.map(([axis, value]) => `${axis}=${value}`).join('+');
  const variant = findVariantByKey(family, key);
  if (variant === undefined) throw new Error('missing exact Standard selection');
  expect(variant.composedWgsl).toContain('fn vs_main');
  expect(variant.reflection?.boundGlobals.length).toBeGreaterThan(0);
  expect(variant.receipt?.directEntry).toBe('vs_main');
  expect(registry.programTemplateInspection().selections).toBe(1);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(published?.wgsl).toContain('fn cs_cluster_layout_probe');
  expect(compile).toHaveBeenCalledTimes(2);
}, 60_000);

it('reuses cooked default programs for exact selections and compiles feature edits normally', async () => {
  const wire = await defaultEngineTemplates();
  const baked = wire.preparedPrograms ?? [];
  expect(baked.length).toBeGreaterThan(4);
  const unlit = baked.filter(({ program }) => program.startsWith('forgeax::default-unlit#'));
  expect(unlit).toHaveLength(7);
  for (const [sceneIndex, clustered] of [
    [true, false],
    [true, true],
    [false, true],
  ]) {
    expect(unlit).toContainEqual(
      expect.objectContaining({
        selection: expect.objectContaining({
          ALPHA_MASK: false,
          ATMOSPHERE_AVAILABLE: false,
          CLUSTER_FORWARD_AVAILABLE: clustered,
          GPU_DRIVEN_SCENE_INDEX_AVAILABLE: sceneIndex,
          GPU_SCENE_DIRECT: false,
          SKINNING_DISABLED: true,
          STORAGE_BUFFER_AVAILABLE: true,
          VERTEX_COLOR_AVAILABLE: false,
        }),
      }),
    );
  }
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  const compile = vi.fn(compiler.compile);
  const compileAsync = vi.fn(async (recipe, selection) => compiler.compile(recipe, selection));
  const registry = new ShaderRegistry({
    manifestUrl: '/prepared-defaults',
    readText: async () => JSON.stringify(wire),
    programCompiler: { ...compiler, compile, compileAsync },
  });
  (await registry.loadManifest()).unwrap();

  const source = new ShaderRegistry({ manifestUrl: undefined, programCompiler: compiler });
  source.installProgramTemplates(wire.library).unwrap();
  for (const selected of baked) {
    expect(registry.prepareProgramTemplate(selected.program, selected.selection).unwrap()).toBe(
      true,
    );
    const actual = registry.resolveProgramTemplate(selected.program, selected.selection).unwrap();
    const expected = source.resolveProgramTemplate(selected.program, selected.selection).unwrap();
    expect(actual.program.sourceReference.identity).toBe(expected.program.sourceReference.identity);
    expect(actual.manifestEntry).toEqual(expected.manifestEntry);
    expect(actual.receipt).toEqual(expected.receipt);
  }
  expect(compile).not.toHaveBeenCalled();
  expect(compileAsync).not.toHaveBeenCalled();
  const rigid = baked.find(
    ({ program, selection }) =>
      program.startsWith('forgeax::default-unlit#') &&
      selection.ATMOSPHERE_AVAILABLE &&
      !selection.GPU_SCENE_DIRECT,
  );
  if (rigid === undefined) throw Error('Missing prepared rigid Unlit program');
  const edited = { ...rigid.selection, ALPHA_MASK: true };
  registry.resolveProgramTemplate(rigid.program, edited).unwrap();
  expect(compile).toHaveBeenCalledOnce();
  expect(compileAsync).not.toHaveBeenCalled();

  const corruptions = [
    { ...rigid, programIdentity: 'stale' },
    { ...rigid, sourceDigest: 'stale' },
    { ...rigid, selection: {} },
    { ...rigid, selection: edited },
    {
      ...rigid,
      artifact: {
        ...rigid.artifact,
        manifestEntry: { ...rigid.artifact.manifestEntry, reflection: {} },
      },
    },
  ];
  for (const corrupted of corruptions)
    expect(admitShaderTemplateManifest({ ...wire, preparedPrograms: [corrupted] }).ok).toBe(false);
  expect(admitShaderTemplateManifest({ ...wire, preparedPrograms: [rigid, rigid] }).ok).toBe(false);

  const changedPreparedSource = {
    ...rigid,
    artifact: {
      ...rigid.artifact,
      manifestEntry: {
        ...rigid.artifact.manifestEntry,
        wgsl: `${rigid.artifact.manifestEntry.wgsl}\n// Modified UTF-8 program`,
      },
    },
  };
  const prepare = vi.fn(async () => ok(compiler));
  const rejected = new ShaderRegistry({
    manifestUrl: '/invalid-prepared-default',
    readText: async () => JSON.stringify({ ...wire, preparedPrograms: [changedPreparedSource] }),
    prepareProgramCompiler: prepare,
  });
  expect((await rejected.loadManifest()).ok).toBe(false);
  expect(prepare).not.toHaveBeenCalled();
  expect([...rejected.entries()]).toEqual([]);
}, 60_000);

it('prepares every built-in source declaration from its published default without missing modules or invented ABI data', async () => {
  const wire = await defaultEngineTemplates();
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
  });
  registry.installProgramTemplates(wire.library).unwrap();
  for (const entry of wire.entries) {
    const result = registry.resolveProgramTemplate(entry.program, entry.selection);
    expect(
      result.ok,
      result.ok
        ? undefined
        : `${entry.identifier}: ${result.error.message} ${JSON.stringify(result.error.detail)}`,
    ).toBe(true);
    if (result.ok) {
      expect(result.value.manifestEntry.reflection).toBeDefined();
      const hasEntries = /@(vertex|fragment|compute)\b/.test(result.value.manifestEntry.wgsl);
      expect((result.value.manifestEntry.entryPoints?.length ?? 0) > 0, entry.identifier).toBe(
        hasEntries,
      );
    }
  }
  expect(registry.programTemplateInspection().selections).toBe(wire.entries.length);
}, 60_000);

it('reflects Standard rigid and skinned Cluster packing from the shared input declaration', async () => {
  const manifest = await defaultEngineTemplates();
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
  });
  registry.installProgramTemplates(manifest.library).unwrap();
  const probe = manifest.entries.find(
    ({ identifier }) => identifier === 'forgeax_standard::cluster_layout_probe',
  );
  if (probe === undefined) throw new Error('Missing shared Cluster layout program');
  const packing = (program: string, selection: Readonly<Record<string, boolean>>) => {
    const reflection = registry.resolveProgramTemplate(program, selection).unwrap()
      .manifestEntry.reflection;
    if (reflection === undefined) throw new Error('Missing Cluster reflection');
    return [30, 33].map((binding) => {
      const global = reflection.boundGlobals.find(
        (row) => row.group === 0 && row.binding === binding,
      );
      if (global === undefined) throw new Error(`Missing Cluster binding ${binding}`);
      const { addressSpace, resourceKind, arrayLength, elementStride, span, members } = global;
      return { addressSpace, resourceKind, arrayLength, elementStride, span, members };
    });
  };
  const expected = packing(probe.program, probe.selection);
  expect(
    probe.preparedReflection?.reflection.boundGlobals
      .filter((row) => row.group === 0 && (row.binding === 30 || row.binding === 33))
      .map(({ addressSpace, resourceKind, arrayLength, elementStride, span, members }) => ({
        addressSpace,
        resourceKind,
        arrayLength,
        elementStride,
        span,
        members,
      })),
  ).toEqual(expected);
  expect(registry.programTemplateInspection().selections).toBe(1);
  for (const identifier of ['forgeax::default-standard-pbr', 'forgeax::pbr-skin']) {
    const material = manifest.materialShaders.find((row) => row.identifier === identifier);
    if (material === undefined) throw new Error(`Missing material ${identifier}`);
    const template = manifest.library.programs[material.program];
    if (template === undefined) throw new Error(`Missing template ${material.program}`);
    const selection = Object.fromEntries(template.axes.map((axis) => [axis, false]));
    expect(
      packing(material.program, {
        ...selection,
        CLUSTER_FORWARD_AVAILABLE: true,
        STORAGE_BUFFER_AVAILABLE: true,
      }),
    ).toEqual(expected);
  }
}, 60_000);

it('publishes Standard coverage reads independently from the motion and lighting passes', async () => {
  const wire = await defaultEngineTemplates();
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
  });
  registry.installProgramTemplates(wire.library).unwrap();

  for (const identifier of ['forgeax::default-standard-pbr', 'forgeax::pbr-skin']) {
    const family = wire.materialShaders.find((entry) => entry.identifier === identifier);
    if (family === undefined) throw new Error(`Missing Standard recipe: ${identifier}`);
    const template = wire.library.programs[family.program];
    if (template === undefined) throw new Error(`Missing Standard source: ${identifier}`);
    const selection = {
      ...Object.fromEntries(template.axes.map((axis) => [axis, false])),
      COVERAGE_ONLY: true,
    };
    for (const lane of [
      {},
      { STORAGE_BUFFER_AVAILABLE: true },
      { STORAGE_BUFFER_AVAILABLE: true, GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true },
      ...(identifier === 'forgeax::default-standard-pbr'
        ? [{ STORAGE_BUFFER_AVAILABLE: true, WATER_WAVES_AVAILABLE: true }]
        : []),
    ]) {
      const compiled = registry.resolveProgramTemplate(family.program, { ...selection, ...lane });
      expect(compiled.ok, compiled.ok ? undefined : compiled.error.message).toBe(true);
      if (!compiled.ok) continue;
      const { entryPoints, reflection } = compiled.value.manifestEntry;
      const vertex = entryPoints?.find(({ name }) => name === 'vs_coverage');
      const packed = entryPoints?.find(({ name }) => name === 'vs_coverage_packed');
      const fragment = entryPoints?.find(({ name }) => name === 'fs_coverage');
      expect(
        vertex?.bindings.find(({ group, binding }) => group === 0 && binding === 0)?.fields,
      ).toEqual(['worldViewProj']);
      expect(packed?.bindings).toEqual(vertex?.bindings);
      expect(fragment?.effects?.mayDiscard).toBe(true);
      expect(fragment?.bindings.some(({ group }) => group === 0)).toBe(false);
      expect(entryPoints?.some(({ name }) => name === 'fs_temporal')).toBe(false);
      const textures = (entry: typeof vertex) =>
        reflection?.boundGlobals
          .filter(
            ({ group, binding, textureClass }) =>
              group === 1 &&
              textureClass === 'sampled' &&
              entry?.bindings.some((read) => read.group === group && read.binding === binding),
          )
          .map(({ name }) => name);
      expect(textures(vertex)).toEqual(['displacementTexture']);
      expect(textures(fragment)).toEqual(['baseColorTexture', 'alphaTexture']);
    }
  }
}, 60_000);

it('changes only clustered-lighting source recipes when offering point shadows', async () => {
  const base = await defaultEngineTemplates();
  const point = await buildEngineShaderTemplateManifest({ pointShadows: true });
  expect(point.entries.map((entry) => entry.identifier)).toEqual(
    base.entries.map((entry) => entry.identifier),
  );
  for (const [index, entry] of base.entries.entries()) {
    const withPoint = point.entries[index];
    if (withPoint === undefined)
      throw new Error(`Missing point-shadow recipe for ${entry.identifier}`);
    if ('CLUSTER_FORWARD_AVAILABLE' in entry.selection) {
      expect(withPoint.program, entry.identifier).not.toBe(entry.program);
    } else {
      expect(withPoint, entry.identifier).toEqual(entry);
    }
  }

  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  for (const [wire, available] of [
    [base, false],
    [point, true],
  ] as const) {
    const registry = new ShaderRegistry({ manifestUrl: undefined, programCompiler: compiler });
    registry.installProgramTemplates(wire.library).unwrap();
    const pbr = wire.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    if (pbr === undefined) throw new Error('Missing Standard recipe');
    const prepared = registry
      .resolveProgramTemplate(pbr.program, { ...pbr.selection, CLUSTER_FORWARD_AVAILABLE: true })
      .unwrap();
    expect(prepared.manifestEntry.wgsl.includes('texture_depth_cube_array')).toBe(available);
    expect(registry.programTemplateInspection().selections).toBe(1);
  }
}, 60_000);

it('keeps native Grade/Final in one source recipe and prepares it only when consumed', async () => {
  const wire = await defaultEngineTemplates();
  const entry = wire.entries.find((row) => row.identifier === 'forgeax::standard-output-v2');
  if (entry === undefined) throw new Error('Missing native output source recipe');
  const registry = new ShaderRegistry({
    manifestUrl: undefined,
    programCompiler: (await prepareShaderProgramCompiler()).unwrap(),
  });
  registry.installProgramTemplates(wire.library).unwrap();
  expect(registry.programTemplateInspection().selections).toBe(0);
  const prepared = registry.resolveProgramTemplate(entry.program, entry.selection).unwrap();
  const names = prepared.manifestEntry.entryPoints?.map((point) => point.name);
  for (const name of [
    'fs_grade',
    'fs_grade_lut',
    'fs_grade_bloom',
    'fs_grade_lut_bloom',
    'fs_final',
    'fs_final_fxaa',
  ])
    expect(names).toContain(name);
  expect(registry.programTemplateInspection().selections).toBe(1);
  expect(
    registry.resolveProgramTemplate(entry.program, entry.selection).unwrap().manifestEntry.wgsl,
  ).toBe(prepared.manifestEntry.wgsl);
  expect(registry.programTemplateInspection().selections).toBe(1);
}, 60_000);

it('admits the shared source payload by producer path and digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-engine-templates-'));
  const output = join(root, 'shared-app-inputs');
  const receipt = join(output, 'manifest.json');
  const payload = 'shared-app-inputs/shaders/manifest.json';
  try {
    await mkdir(join(output, 'shaders'), { recursive: true });
    const expected = await defaultEngineTemplates();
    const text = JSON.stringify(expected);
    const outputFingerprint = `sha256:${createHash('sha256').update(payload).update('\0').update(text).update('\0').digest('hex')}`;
    const envelope = {
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      shaderPublication: 'source',
      payload: { engineShaderManifest: payload },
      inventory: [payload],
      shaderBuild: { outputFingerprint },
    };
    await writeFile(receipt, JSON.stringify(envelope));
    await writeFile(join(root, payload), text);
    const options = { pointShadows: false, hdrpSsao: true } as const;
    const engineWorkspace = join(root, 'engine-source');
    expect(loadSharedEngineShaderTemplates(receipt, options)).toEqual(expected);
    expect(
      loadSharedEngineShaderTemplates(receipt, { ...options, pointShadows: true }),
    ).toBeUndefined();
    const compose = vi.spyOn(naga, 'composeShader');
    vi.stubEnv('FORGEAX_SHARED_APP_INPUTS_MANIFEST', receipt);
    try {
      const input = await buildEngineShaderManifest({ workspaceRoot: engineWorkspace });
      expect(JSON.stringify(input)).toBe(text);
      expect(
        input.materialShaders.some((row) => row.identifier === 'forgeax::default-standard-pbr'),
      ).toBe(true);
      expect(compose).not.toHaveBeenCalled();
    } finally {
      compose.mockRestore();
      vi.unstubAllEnvs();
    }
    await writeFile(receipt, JSON.stringify(envelope).replaceAll('shared-app-inputs/', 'other/'));
    expect(() => loadSharedEngineShaderTemplates(receipt, options)).toThrow(
      'Shared shader template payload path mismatch',
    );
    await writeFile(receipt, JSON.stringify(envelope));
    await writeFile(join(root, payload), `${text} `);
    expect(() => loadSharedEngineShaderTemplates(receipt, options)).toThrow(
      'Shared shader template payload digest mismatch',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
