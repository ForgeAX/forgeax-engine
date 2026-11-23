import { parsePackSourceJson, projectDirectPackJson } from '@forgeax/engine-pack/source';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const demoRoot = resolve(import.meta.dirname, '../..');
const packPath = resolve(demoRoot, 'assets/boss-lightning.pack.json');
const entryPath = resolve(demoRoot, 'src/main.ts');
const scenePath = resolve(demoRoot, 'src/scene.ts');
const materialsPath = resolve(demoRoot, 'assets/boss-lightning-materials.pack.json');
const arcNovaEmitterIds = [
  'charge-arcane-dial',
  'impact-violet-shock',
];
const bossMaterialGuids = [
  '144bb700-fd1d-5438-94ba-135b40f9b89f',
  '4d14516c-9b46-5c94-accc-c07558997bf4',
  '62a68cb2-1028-556d-8e46-e425a803478f',
  'e395f457-6551-59ab-8752-ae2285b56864',
];
const authoredShaderFiles = [
  'arc-nova-sigil.wgsl',
  'arc-nova-violet-sigil.wgsl',
];

describe('Boss Lightning source and Pack declaration', () => {
  it('uses one source-only authored Pack entry', () => {
    const pack = parsePackSourceJson(JSON.parse(readFileSync(packPath, 'utf8'))).unwrap();
    if (pack.format !== 'direct') throw new Error('Boss Lightning must be a direct Pack');
    const rows = projectDirectPackJson(pack).assets;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guid: 'c76202f1-8caa-5873-a899-a372ea0b5cfc',
      sourceKey: 'vfx/boss-lightning',
      kind: 'particle-effect',
    });
    const authored = parseParticleEffectSourceV3(rows[0]?.payload);
    expect(authored.ok).toBe(true);
    if (!authored.ok) throw new Error(authored.error.hint);
    if ('parent' in authored.value) throw new Error('Boss Lightning must be a root effect');
    expect(authored.value.emitters.map((emitter) => emitter.id)).toEqual([
      'mouth-charge',
      'lightning-ribbon',
      'lightning-trail',
      'lightning-beam',
      'impact-mesh',
      ...arcNovaEmitterIds,
    ]);
    expect(new Set(authored.value.emitters.flatMap((emitter) => emitter.renderers.map((renderer) => renderer.kind)))).toEqual(
      new Set(['billboard', 'ribbon', 'trail', 'beam', 'mesh']),
    );
    for (const emitter of authored.value.emitters.slice(5)) {
      expect(emitter.backend.required).toBe('gpu');
      expect(emitter.space).toBe('world');
      expect(emitter.schedule.loopDuration).toBeGreaterThan(0);
      expect(() => readFileSync(resolve(demoRoot, 'assets', emitter.program.module), 'utf8')).not.toThrow();
    }
    expect(rows[0]?.refs).toEqual([]);
    expect(rows[0]?.artifacts ?? {}).toEqual({});
  });

  it('does not retain the former source, sidecar, or importer path', () => {
    const vite = readFileSync(resolve(demoRoot, 'vite.config.ts'), 'utf8');
    expect(vite).not.toContain('particleEffectImporter');
    expect(vite).toContain('createParticleCodeNativeCookerFromRoots');
    expect(vite).not.toContain('vfxModules');
    expect(vite).toContain("createParticleCodeNativeCookerFromRoots([resolve(here, 'assets')])");
    expect(vite).toContain('cookers:');
    expect(() => readFileSync(resolve(demoRoot, 'assets/boss-lightning.particle-effect.json'), 'utf8')).toThrow();
    expect(() => readFileSync(resolve(demoRoot, 'assets/boss-lightning.particle-effect.json.meta.json'), 'utf8')).toThrow();
  });

  it('publishes a private shader namespace without colliding with the capability app', () => {
    const helloIds = authoredShaderFiles.map((file) => {
      const source = readFileSync(resolve(demoRoot, 'assets', file), 'utf8');
      return source.match(/^#define_import_path\s+(\S+)/m)?.[1];
    });
    const capabilityRoot = resolve(demoRoot, '../../game-capability-lab/assets');
    const capabilityIds = authoredShaderFiles.map((file) =>
      readFileSync(resolve(capabilityRoot, file), 'utf8').match(/^#define_import_path\s+(\S+)/m)?.[1],
    );
    expect(helloIds).toEqual([
      'hello_boss_lightning::arc_nova_sigil',
      'hello_boss_lightning::arc_nova_violet_sigil',
    ]);
    expect(new Set(helloIds).size).toBe(authoredShaderFiles.length);
    expect(helloIds.some((id) => capabilityIds.includes(id))).toBe(false);
  });

  it('requires the public GUID-to-pixels assembly before the demo turns green', () => {
    const entry = readFileSync(entryPath, 'utf8');
    expect(entry).toContain('loadVfxGpuEffect(assets, EFFECT_GUID)');
    expect(entry).toContain('createVfxRuntimeHost');
    expect(entry).toContain('host.feature');
    expect(entry).toContain('ParticleEffectPlayer');
  });

  it('requires a visible Boss, mouth light, ground warning, and strike composition', () => {
    const scene = readFileSync(scenePath, 'utf8');
    const materials = parsePackSourceJson(JSON.parse(readFileSync(materialsPath, 'utf8'))).unwrap();
    if (materials.format !== 'direct') throw new Error('Boss Lightning materials must be direct');

    expect(scene).toContain("createPrimitiveMesh('sphere')");
    expect(scene).toContain("createPrimitiveMesh('cylinder')");
    expect(scene).toContain('PointLight');
    expect(scene).toContain('groundWarning');
    expect(scene).toContain('materials.body');
    expect(scene).toContain('materials.strike');
    expect(projectDirectPackJson(materials).assets.map((asset) => asset.guid)).toEqual(expect.arrayContaining(bossMaterialGuids));
  });
});
