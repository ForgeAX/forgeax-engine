import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../assembly/material/surface-projection';
import { layerPlanFor, passFor, SURFACE_CASES } from './surface-standard-pipeline.fixture';

describe('Standard Surface render projection contract', () => {
  it('projects every published cell to its declared pass and Surface module', () => {
    for (const surfaceCase of SURFACE_CASES) {
      const passes = projectStandardSurfacePasses({
        surfaceModule: surfaceCase.surfaceModule,
        values: surfaceCase.material.values ?? {},
        geometryVariant: 'rigid',
        lightingLane: 'direct',
        alphaClip: true,
        layerPlan: layerPlanFor(surfaceCase),
      });
      expect(passes.some((entry) => entry.name === passFor(surfaceCase))).toBe(true);
      expect(passes[0]?.program.moduleSlots?.surface).toBe(surfaceCase.surfaceModule);
    }
  });
});
