import { describe, expect, it } from 'vitest';
import { buildMaterialSourceCatalog } from '../material/source-catalog.js';

const engineSource = (moduleId: string) =>
  `#define_import_path ${moduleId}\nfn engine_value() -> f32 { return 1.0; }`;

const projectSource = (moduleId: string) =>
  `#define_import_path ${moduleId}\nfn project_value() -> f32 { return 2.0; }`;

describe('material WGSL source catalog', () => {
  it('rejects a source without a compiler-native module ID', () => {
    const result = buildMaterialSourceCatalog({
      engine: [{ source: 'fn main() {}', path: 'engine/missing.wgsl' }],
      project: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    {
      expect(result.error.code).toBe('shader-module-id-missing');
      const detail = result.error.detail as { source: string };
      expect(detail.source).toBe('engine/missing.wgsl');
    }
  });

  it('rejects duplicate IDs even when provenance differs', () => {
    const result = buildMaterialSourceCatalog({
      engine: [{ source: engineSource('game::paint'), path: 'engine/paint.wgsl' }],
      project: [{ source: projectSource('game::paint'), path: 'materials/paint.wgsl' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    {
      expect(result.error.code).toBe('shader-module-id-duplicate');
      const detail = result.error.detail as { module: string; sources: readonly string[] };
      expect(detail.module).toBe('game::paint');
      expect(detail.sources).toEqual(['engine/paint.wgsl', 'materials/paint.wgsl']);
    }
  });

  it('rejects engine namespace IDs from project sources', () => {
    const result = buildMaterialSourceCatalog({
      engine: [],
      project: [{ source: projectSource('forgeax_material::paint'), path: 'paint.wgsl' }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    {
      expect(result.error.code).toBe('shader-module-namespace-reserved');
      const detail = result.error.detail as { namespace: string };
      expect(detail.namespace).toBe('forgeax_material');
    }
  });

  it('reports an unresolved reference with the caller provenance', () => {
    const result = buildMaterialSourceCatalog({
      engine: [{ source: engineSource('forgeax_material::base'), path: 'engine/base.wgsl' }],
      project: [{ source: projectSource('game::entry'), path: 'entry.wgsl' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const missing = result.value.resolve('game::missing', 'entry.wgsl');
      expect(missing.ok).toBe(false);
      if (!missing.ok) {
        expect(missing.error.code).toBe('shader-module-not-found');
        const detail = missing.error.detail as { source: string };
        expect(detail.source).toBe('entry.wgsl');
      }
    }
  });

  it('keeps module identity stable when only the physical path moves', () => {
    const first = buildMaterialSourceCatalog({
      engine: [],
      project: [{ source: projectSource('game::paint'), path: 'old/paint.wgsl' }],
    });
    const moved = buildMaterialSourceCatalog({
      engine: [],
      project: [{ source: projectSource('game::paint'), path: 'new/paint.wgsl' }],
    });

    expect(first.ok).toBe(true);
    expect(moved.ok).toBe(true);
    if (!first.ok || !moved.ok) return;
    {
      const firstRecord = first.value.get('game::paint');
      const movedRecord = moved.value.get('game::paint');
      if (!firstRecord.ok || !movedRecord.ok) return;
      expect(firstRecord.value.moduleId).toBe('game::paint');
      expect(movedRecord.value.moduleId).toBe('game::paint');
    }
  });

  it('accepts hyphens in project module namespaces and names', () => {
    const result = buildMaterialSourceCatalog({
      engine: [],
      project: [{ source: projectSource('my-game::pulse-material'), path: 'pulse-material.wgsl' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const module = result.value.get('my-game::pulse-material');
      expect(module.ok).toBe(true);
      if (module.ok) expect(module.value.moduleId).toBe('my-game::pulse-material');
    }
  });

  it('preserves the source roots used for engine and project provenance', () => {
    const roots = ['/engine/shaders', '/game/assets'];
    const result = buildMaterialSourceCatalog({
      roots,
      engine: [{ source: engineSource('forgeax::standard'), path: 'engine/standard.wgsl' }],
      project: [{ source: projectSource('game::paint'), path: 'materials/paint.wgsl' }],
    });

    expect(result).toMatchObject({ ok: true, value: { roots } });
  });

  it('records source-owned slots and resolves their selected modules', () => {
    const result = buildMaterialSourceCatalog({
      engine: [],
      project: [
        {
          path: 'entry.wgsl',
          source:
            '#define_import_path game::entry\n#pragma material_slot lighting\n#import forgeax_material::slot::lighting::{lighting_color}\nfn main() {}',
        },
        { path: 'toon.wgsl', source: projectSource('game::toon') },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.get('game::entry');
    expect(entry.ok).toBe(true);
    if (!entry.ok) return;
    expect(entry.value.slots).toEqual(['lighting']);
    expect(result.value.resolveSlot('game::entry', 'lighting', 'game::toon').ok).toBe(true);
    expect(result.value.resolveSlot('game::entry', 'fog', 'game::toon').ok).toBe(false);
  });
});
