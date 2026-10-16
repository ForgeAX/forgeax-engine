import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import { parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../assets');
const canonical = ['mouth-charge', 'lightning-ribbon', 'lightning-trail', 'lightning-beam', 'impact-mesh', 'charge-arcane-dial', 'charge-hex-seal', 'charge-prismatic-crown', 'release-axis-lance', 'release-radial-blades', 'impact-violet-shock', 'impact-cross-crown', 'decay-ember-facets'];
const materialPacks = [
  'boss-lightning-materials.pack.json',
  'arc-nova-sigil.shader.pack.json',
  'arc-nova-shard.shader.pack.json',
  'arc-nova-violet-sigil.shader.pack.json',
  'arc-nova-ember-shard.shader.pack.json',
] as const;

type MaterialPack = {
  readonly packageId: string;
  readonly assets: Readonly<Record<string, { readonly kind: string }>>;
};

function derivedMaterialGuids(): ReadonlySet<string> {
  const guids = new Set<string>();
  for (const file of materialPacks) {
    const pack = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as MaterialPack;
    const packageId = PackageId.parse(pack.packageId);
    if (!packageId.ok) throw new Error(`${file} has an invalid packageId`);
    for (const [sourceKey, asset] of Object.entries(pack.assets)) {
      if (asset.kind === 'material') {
        guids.add(AssetGuid.format(AssetGuid.derive(packageId.value, sourceKey)));
      }
    }
  }
  return guids;
}

function effect(file: string) {
  const pack = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as { assets: Array<{ guid: string; payload: unknown }> };
  const entry = pack.assets[0];
  if (entry === undefined) throw new Error(`${file} has no asset`);
  const parsed = parseParticleEffectSourceV3(entry.payload);
  if (!parsed.ok) throw new Error(parsed.error.hint);
  return { guid: entry.guid, value: parsed.value };
}

describe('game-default Boss Lightning suite', () => {
  it('publishes every canonical emitter exactly once in three event scopes', () => {
    const suite = effect('boss-lightning-suite.pack.json');
    const emitters = suite.value.emitters.map((entry) => entry.id);
    expect(emitters).toEqual(canonical);
    expect(new Set(emitters).size).toBe(13);
    expect(['boss-lightning-telegraph.pack.json', 'boss-lightning-flight.pack.json', 'boss-lightning-contact.pack.json'].map((file) => effect(file).value.emitters.length)).toEqual([4, 5, 4]);
    expect(suite.guid).not.toMatch(/hello|boss-lightning-demo/);
  });

  it('keeps the closed renderer-kind set without fallback', () => {
    const kinds = new Set(effect('boss-lightning-suite.pack.json').value.emitters.flatMap((entry) => entry.renderers.map((renderer) => renderer.kind)));
    expect([...kinds].sort()).toEqual(['beam', 'billboard', 'mesh', 'ribbon', 'trail']);
  });

  it('closes every Boss Lightning renderer material through Pack identity', () => {
    const materialGuids = derivedMaterialGuids();
    for (const file of ['boss-lightning-suite.pack.json', 'boss-lightning-telegraph.pack.json', 'boss-lightning-flight.pack.json', 'boss-lightning-contact.pack.json']) {
      for (const emitter of effect(file).value.emitters) {
        for (const renderer of emitter.renderers) {
          expect(materialGuids.has(renderer.material), `${file}/${emitter.id}`).toBe(true);
        }
      }
    }
  });

  it('keeps hostile emitters event-local to their carrier transforms', () => {
    for (const file of ['boss-lightning-suite.pack.json', 'boss-lightning-telegraph.pack.json', 'boss-lightning-flight.pack.json', 'boss-lightning-contact.pack.json']) {
      for (const emitter of effect(file).value.emitters) {
        expect(emitter.space).toBe('local');
        expect(emitter.bounds?.kind).toBe('sphere');
        if (emitter.bounds?.kind === 'sphere') expect(emitter.bounds.center).toEqual([0, 0, 0]);
      }
    }
  });

  it('keeps lifecycle and unavailable behavior in the shared host owner', () => {
    const source = readFileSync(resolve(root, 'plugins/gameplay-vfx.ts'), 'utf8');
    expect((source.match(/createVfxRuntimeHost\(/g) ?? []).length).toBe(1);
    expect(source).toContain('stopHostile');
    expect(source).toContain('impactCarriers');
    expect(source).toContain("'host-unavailable'");
    expect(source).toContain('renderFeaturePlugin(host.feature)');
    expect(source).not.toContain('renderFeatureDiagnostics');
    expect(source).not.toContain('Float32Array[]');
  });

  it('aligns flight topology with projectile local +Y', () => {
    const beam = readFileSync(resolve(root, 'lightning-beam.vfx.wgsl'), 'utf8');
    const ribbon = readFileSync(resolve(root, 'lightning-ribbon.vfx.wgsl'), 'utf8');
    const trail = readFileSync(resolve(root, 'lightning-trail.vfx.wgsl'), 'utf8');
    expect(beam).toContain('vec3<f32>(0.0, 2.25');
    expect(ribbon).toContain('step * 2.15');
    expect(trail).toContain('1.65, 0.0');
  });
});
