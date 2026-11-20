import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as naga from '@forgeax/engine-naga';
import { findVariantByKey, materialShaderAxes, ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler';
import { expect, it, vi } from 'vitest';
import { buildEngineShaderManifest, buildEngineShaderTemplateManifest } from '../index.js';
import { loadSharedEngineShaderTemplates } from '../shared-engine-inputs.js';

it('publishes Engine modules and axes without composing any variant, then prepares only the requested Standard program', async () => {
  const compose = vi.spyOn(naga, 'composeShader');
  try {
    const wire = await buildEngineShaderTemplateManifest();
    expect(compose).not.toHaveBeenCalled();
    expect(wire.schemaVersion).toBe('7.0.0');
    expect(wire.entries.length).toBeGreaterThan(50);
    expect(Object.keys(wire.library.programs).length).toBe(wire.entries.length);
    expect(JSON.stringify(wire)).not.toContain('composedWgsl');
    const compiler = (await prepareShaderProgramCompiler()).unwrap();
    const registry = new ShaderRegistry({
      manifestUrl: '/templates',
      readText: async () => JSON.stringify(wire),
      programCompiler: compiler,
    });
    (await registry.loadManifest()).unwrap();
    expect(registry.programTemplateInspection().selections).toBe(0);
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
  } finally {
    compose.mockRestore();
  }
}, 60_000);

it('prepares every built-in source declaration from its published default without missing modules or invented ABI data', async () => {
  const wire = await buildEngineShaderTemplateManifest();
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

it('changes only clustered-lighting source recipes when offering point shadows', async () => {
  const base = await buildEngineShaderTemplateManifest();
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
  const wire = await buildEngineShaderTemplateManifest();
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
    const expected = await buildEngineShaderTemplateManifest();
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
