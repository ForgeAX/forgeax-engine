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
  '019e9c00-0000-7000-8000-000000000003',
  '019e9c00-0000-7000-8000-000000000004',
  '019e9c00-0000-7000-8000-000000000005',
  '019e9c00-0000-7000-8000-000000000006',
];
const authoredShaderFiles = [
  'arc-nova-sigil.wgsl',
  'arc-nova-violet-sigil.wgsl',
];

describe('Boss Lightning source and Pack declaration', () => {
  it('uses one source-only authored Pack entry', () => {
    const pack = JSON.parse(readFileSync(packPath, 'utf8')) as {
      schemaVersion: string;
      kind: string;
      assets: Array<{
        guid: string;
        kind: string;
        execution: 'direct' | 'cooked';
        payload: unknown;
        refs: string[];
        artifacts?: Record<string, { path: string }>;
      }>;
    };

    expect(pack).toMatchObject({ schemaVersion: '2.0.0', kind: 'internal-text-package' });
    expect(pack.assets).toHaveLength(1);
    expect(pack.assets[0]).toMatchObject({
      guid: '019e9c00-0000-7000-8000-000000000000',
      kind: 'particle-effect',
      execution: 'cooked',
    });
    const authored = parseParticleEffectSourceV3(pack.assets[0]?.payload);
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
    expect(pack.assets[0]?.refs).toEqual([]);
    expect(pack.assets[0]?.artifacts).toEqual({});
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
    const materials = JSON.parse(readFileSync(materialsPath, 'utf8')) as {
      assets: Array<{ guid: string }>;
    };
    expect(scene).toContain('HANDLE_SPHERE');
    expect(scene).toContain('HANDLE_CYLINDER');
    expect(scene).toContain('PointLight');
    expect(scene).toContain('groundWarning');
    expect(scene).toContain('materials.body');
    expect(scene).toContain('materials.strike');
    expect(materials.assets.map(asset => asset.guid)).toEqual(expect.arrayContaining(bossMaterialGuids));
  });
});
