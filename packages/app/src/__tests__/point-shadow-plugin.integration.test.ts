import { Context, type Plugin } from '@forgeax/engine-plugin';
import { type Renderer, SHADOW_ATLAS_DEFAULT_LAYERS } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import {
  admitPointShadowBudget,
  POINT_SHADOW_PLUGIN_ID,
  PointShadowRecipeError,
  pointShadowPlugin,
  rendererPlugin,
} from '../renderer-plugin';

function fakeRenderer(storageBuffer: boolean, status: 'ready' | 'unavailable' = 'ready'): Renderer {
  return {
    inspect: () => ({
      capabilities: { storageBuffer },
      pointShadow: {
        status,
        requested: 2,
        admitted: 2,
        shadowed: 2,
        shadowAtlasOccupancy: 2,
        shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
      },
    }),
  } as unknown as Renderer;
}

describe('point-shadow App recipe', () => {
  it('declares one renderer dependency and exposes detached inspection', async () => {
    const plugin = pointShadowPlugin();
    expect(plugin.name).toBe(POINT_SHADOW_PLUGIN_ID);
    expect(plugin.inject).toEqual(['renderer']);
    expect(plugin.provide).toBe('pointShadow');

    const context = new Context();
    await context.plugin(rendererPlugin(fakeRenderer(true)));
    await context.plugin(plugin);
    expect(context.pointShadow?.inspect()).toEqual({
      status: 'ready',
      requested: 2,
      admitted: 2,
      shadowed: 2,
      shadowAtlasOccupancy: 2,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
    const admission = context.pointShadow?.admit(SHADOW_ATLAS_DEFAULT_LAYERS);
    expect(admission?.ok).toBe(true);
    await context.fiber.dispose();
  });

  it('returns structured failures for capability, budget, and disabled variants', () => {
    const missing = admitPointShadowBudget(1, 'storageBuffer');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toBeInstanceOf(PointShadowRecipeError);
      expect(missing.error.code).toBe('point-shadow-capability-missing');
      expect(missing.error.detail).toMatchObject({ capability: 'storageBuffer', requested: 1 });
      expect(missing.error.hint).toContain('storageBuffer');
    }

    const overBudget = admitPointShadowBudget(SHADOW_ATLAS_DEFAULT_LAYERS + 1);
    expect(overBudget.ok).toBe(false);
    if (!overBudget.ok) {
      expect(overBudget.error.code).toBe('point-shadow-budget-exceeded');
      expect(overBudget.error.detail).toEqual({
        requested: SHADOW_ATLAS_DEFAULT_LAYERS + 1,
        capacity: SHADOW_ATLAS_DEFAULT_LAYERS,
      });
    }

    const invalid = admitPointShadowBudget(-1);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('point-shadow-invalid-request');
  });

  it('keeps capability optional while missing storage support is actionable', async () => {
    const context = new Context();
    await context.plugin(rendererPlugin(fakeRenderer(false)));
    await context.plugin(pointShadowPlugin());
    const admission = context.pointShadow?.admit(1);
    expect(admission?.ok).toBe(false);
    if (admission !== undefined && !admission.ok) {
      expect(admission.error.code).toBe('point-shadow-capability-missing');
    }
    await context.fiber.dispose();
  });

  it('rejects admission when the loaded shaders cannot sample point shadows', async () => {
    const context = new Context();
    await context.plugin(rendererPlugin(fakeRenderer(true, 'unavailable')));
    await context.plugin(pointShadowPlugin());
    const admission = context.pointShadow?.admit(1);
    expect(admission?.ok).toBe(false);
    if (admission !== undefined && !admission.ok) {
      expect(admission.error.code).toBe('point-shadow-capability-missing');
      expect(admission.error.detail.capability).toBe('pointShadowShader');
      expect(admission.error.hint).toContain('pointShadows: true');
    }
    await context.fiber.dispose();
  });

  it('does not add a second renderer provider when consumed in a profile', () => {
    const consumer: Plugin = {
      name: 'point-shadow-consumer',
      inject: ['pointShadow'],
      apply() {},
    };
    expect(consumer.inject).toEqual(['pointShadow']);
  });
});
