import { describe, expect, it } from 'vitest';
import {
  extractDefineImportPath,
  loadEngineShaderEntries,
  projectSurfaceSlotSource,
  SURFACE_SLOT_MODULE,
} from '../engine-inputs/load-engine-shader-entries.js';

describe('Surface manifest engine inputs', () => {
  it('publishes Standard and Surface modules through the engine input owner', async () => {
    const entries = await loadEngineShaderEntries();
    const ids = [
      entries.defaultStandardPbr.reservedIdentifier,
      entries.defaultStandardPbrSkin.reservedIdentifier,
    ];
    expect(ids).toEqual(['forgeax::default-standard-pbr', 'forgeax::pbr-skin']);
    expect(entries.singleLayerMedium.reservedIdentifier).toBe('forgeax::single-layer-medium');
    expect(entries.singleLayerMedium.source).toContain('SingleLayerMediumSurfaceData');
    expect(extractDefineImportPath(entries.defaultStandardPbr.source)).toBe(
      'forgeax_material::standard',
    );
    expect(entries.imports['forgeax_material::surface_v1']).toContain('SurfaceInput');
    expect(entries.imports['forgeax_material::default_standard_surface']).toContain(
      'standard_surface',
    );
    expect(entries.imports['forgeax_material::surface_v1']).toContain('alphaClipThreshold');
    expect(entries.imports['forgeax_material::surface_v1']).not.toContain('clearcoat');
    const defaultSurface = entries.imports['forgeax_material::default_standard_surface'];
    expect(defaultSurface).toBeDefined();
    if (defaultSurface === undefined) return;
    expect(entries.imports[SURFACE_SLOT_MODULE]).toBe(projectSurfaceSlotSource(defaultSurface));
  });

  it('keeps one published material input per Standard template', async () => {
    const entries = await loadEngineShaderEntries();
    const materialEntries = [entries.defaultStandardPbr, entries.defaultStandardPbrSkin];
    expect(new Set(materialEntries.map((entry) => entry.reservedIdentifier)).size).toBe(
      materialEntries.length,
    );
    expect(materialEntries.every((entry) => entry.source.includes('material_slot surface'))).toBe(
      true,
    );
  });
});
