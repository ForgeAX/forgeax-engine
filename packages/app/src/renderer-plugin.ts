import type { Plugin } from '@forgeax/engine-plugin';
import {
  type PointShadowInspection,
  type RenderError,
  type Renderer,
  type RenderFeature,
  type RenderResult,
  SHADOW_ATLAS_DEFAULT_LAYERS,
} from '@forgeax/engine-render';
import type { RendererFeatureAssemblyHost } from '@forgeax/engine-render/internal/construct-renderer';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface RenderFeatureHost {
  installFeature(
    feature: RenderFeature<unknown>,
  ): Promise<RenderResult<RenderFeatureLease, RenderError>>;
}

export interface RenderFeatureLease {
  release(): Promise<RenderResult<void, RenderError>>;
}

export function createRenderFeatureHost(host: RendererFeatureAssemblyHost): RenderFeatureHost {
  return {
    async installFeature(feature) {
      const installed = await host.installRenderFeature(feature);
      if (!installed.ok) return installed;
      let released = false;
      return {
        ok: true,
        value: {
          release: async () => {
            if (released) return { ok: true, value: undefined };
            released = true;
            return host.uninstallRenderFeature(feature);
          },
        },
      };
    },
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    renderer?: Renderer;
    renderFeatureHost?: RenderFeatureHost;
    pointShadow?: PointShadowCapability;
  }
}

/** Stable capability name used by a recipe to discover point-shadow support. */
export const POINT_SHADOW_PLUGIN_ID = 'forgeax::point-shadow';

export type PointShadowRecipeErrorCode =
  | 'point-shadow-capability-missing'
  | 'point-shadow-budget-exceeded'
  | 'point-shadow-invalid-request';

/**
 * Renderer facts a point-shadow recipe needs: the storage-buffer device lane
 * and a Standard shader build that samples the cube atlas.
 */
export type PointShadowCapabilityRequirement = 'storageBuffer' | 'pointShadowShader';

export interface PointShadowRecipeErrorDetail {
  readonly requested: number;
  readonly capacity: number;
  readonly capability?: PointShadowCapabilityRequirement;
}

/** Structured preflight error returned by the point-shadow recipe capability. */
export class PointShadowRecipeError extends Error {
  readonly code: PointShadowRecipeErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointShadowRecipeErrorDetail;

  constructor(code: PointShadowRecipeErrorCode, detail: PointShadowRecipeErrorDetail) {
    const policy: Readonly<
      Record<PointShadowRecipeErrorCode, { readonly expected: string; readonly hint: string }>
    > = {
      'point-shadow-capability-missing':
        detail.capability === 'pointShadowShader'
          ? {
              expected: 'the loaded Standard shaders sample the point-shadow cube atlas',
              hint: 'build shaders with forgeaxShader({ engineEntries: { pointShadows: true } }) or keep point shadows disabled',
            }
          : {
              expected:
                'the renderer exposes the storage-buffer lane required by the point-shadow recipe',
              hint: 'choose a renderer/backend with storageBuffer support or keep point shadows disabled',
            },
      'point-shadow-budget-exceeded': {
        expected: `requested point shadows fit the atlas capacity (${SHADOW_ATLAS_DEFAULT_LAYERS})`,
        hint: `reduce PointLightShadow casters to ${SHADOW_ATLAS_DEFAULT_LAYERS} or fewer`,
      },
      'point-shadow-invalid-request': {
        expected: 'requested point shadows are a non-negative safe integer',
        hint: 'pass a non-negative integer count to pointShadow.admit()',
      },
    };
    super(`point-shadow recipe rejected: ${code}`);
    this.name = 'PointShadowRecipeError';
    this.code = code;
    this.expected = policy[code].expected;
    this.hint = policy[code].hint;
    this.detail = detail;
  }
}

/** Runtime capability exposed by {@link pointShadowPlugin}. */
export interface PointShadowCapability {
  /** Detached budget/occupancy facts from the last submitted renderer frame. */
  inspect(): PointShadowInspection;
  /** Preflight a requested number of point-shadow casters against this device. */
  admit(requested: number): Result<number, PointShadowRecipeError>;
}

const INACTIVE_POINT_SHADOW: PointShadowInspection = Object.freeze({
  status: 'inactive',
  requested: 0,
  admitted: 0,
  shadowed: 0,
  shadowAtlasOccupancy: 0,
  shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
});

/** Validate a point-shadow request without reaching into a Renderer. */
export function admitPointShadowBudget(
  requested: number,
  missingCapability?: PointShadowCapabilityRequirement,
): Result<number, PointShadowRecipeError> {
  const detail = {
    requested,
    capacity: SHADOW_ATLAS_DEFAULT_LAYERS,
  } satisfies PointShadowRecipeErrorDetail;
  if (missingCapability !== undefined) {
    return err(
      new PointShadowRecipeError('point-shadow-capability-missing', {
        ...detail,
        capability: missingCapability,
      }),
    );
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return err(new PointShadowRecipeError('point-shadow-invalid-request', detail));
  }
  if (requested > SHADOW_ATLAS_DEFAULT_LAYERS) {
    return err(new PointShadowRecipeError('point-shadow-budget-exceeded', detail));
  }
  return ok(requested);
}

/** Install the minimal point-shadow recipe in an App/Worker Cordis realm. */
export function pointShadowPlugin(): Plugin {
  return {
    name: POINT_SHADOW_PLUGIN_ID,
    inject: ['renderer'],
    provide: 'pointShadow',
    apply(ctx) {
      const renderer = ctx.renderer;
      if (renderer === undefined) {
        throw new PointShadowRecipeError('point-shadow-capability-missing', {
          requested: 0,
          capacity: SHADOW_ATLAS_DEFAULT_LAYERS,
          capability: 'storageBuffer',
        });
      }
      const capability: PointShadowCapability = {
        inspect() {
          const inspection = renderer.inspect().pointShadow;
          return Object.freeze({ ...(inspection ?? INACTIVE_POINT_SHADOW) });
        },
        admit(requested) {
          const inspection = renderer.inspect();
          return admitPointShadowBudget(
            requested,
            inspection.capabilities.storageBuffer !== true
              ? 'storageBuffer'
              : inspection.pointShadow?.status === 'unavailable'
                ? 'pointShadowShader'
                : undefined,
          );
        },
      };
      ctx.provide('pointShadow', capability);
    },
  };
}

/** Provide the renderer without transferring its host-owned lifetime. */
export function rendererPlugin(renderer: Renderer): Plugin {
  return {
    name: 'renderer',
    provide: 'renderer',
    apply(ctx) {
      ctx.provide('renderer', renderer);
    },
  };
}

/** Provide an App/Worker-owned Renderer and release it after dependent Fibers. */
export function ownedRendererPlugin(renderer: Renderer): Plugin {
  return {
    name: 'renderer',
    provide: 'renderer',
    apply(ctx) {
      ctx.provide('renderer', renderer);
      ctx.effect(() => () => renderer.dispose(), 'render/renderer');
    },
  };
}

/** Provide the App-owned late RenderFeature assembly capability. */
export function renderFeatureHostPlugin(host: RenderFeatureHost): Plugin {
  return {
    name: 'render-feature-host',
    provide: 'renderFeatureHost',
    apply(ctx) {
      ctx.provide('renderFeatureHost', host);
    },
  };
}

/** Install a producer feature under the same Cordis Fiber that owns the caller. */
export function renderFeaturePlugin(feature: RenderFeature<unknown>): Plugin {
  return {
    name: `render-feature:${feature.identity}`,
    inject: ['renderFeatureHost'],
    async apply(ctx) {
      if (ctx.renderFeatureHost === undefined) {
        throw new Error('render-feature host capability is unavailable in this App realm');
      }
      const installed = await ctx.renderFeatureHost.installFeature(feature);
      if (!installed.ok) throw installed.error;
      ctx.effect(
        () => async () => {
          const removed = await installed.value.release();
          if (!removed.ok) throw removed.error;
        },
        `render-feature/${feature.identity}`,
      );
    },
  };
}
