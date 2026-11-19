import * as naga from '@forgeax/engine-naga';
import { findVariantByKey, materialShaderAxes, ShaderRegistry } from '@forgeax/engine-shader';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler';
import { expect, it, vi } from 'vitest';
import { buildEngineShaderTemplateManifest } from '../index.js';

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
