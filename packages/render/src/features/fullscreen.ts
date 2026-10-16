import { ok } from '@forgeax/engine-types';
import type {
  FullscreenRenderFeatureStage,
  RenderFeatureFullscreenRead,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
} from './plan';
import type { RenderFeature, RenderFeatureExtractContext } from './types';

/** Host-owned fullscreen effect declaration carried by one RenderFeature. */
export interface FullscreenRenderFeatureDeclaration {
  readonly identity: string;
  readonly source: string;
  /** Scene-linear effects run on the jittered lattice before temporal reconstruction. */
  readonly stage?: FullscreenRenderFeatureStage;
  readonly reads?: readonly RenderFeatureFullscreenRead[];
  readonly params?: {
    readonly byteSize: number;
    readonly defaultValue: Uint8Array;
  };
}

export interface FullscreenRenderFeatureOptions extends FullscreenRenderFeatureDeclaration {
  /** Source-owned enable state; false publishes no fullscreen work. */
  readonly enabled?: (context: RenderFeatureExtractContext) => boolean;
}

// Separate package entry bundles must recognize the same realm-local factory result.
const declarationKey = Symbol.for('forgeax.render.fullscreen-declaration');

/** Engine-owned projection; producer callbacks never cross the Worker boundary. */
export function fullscreenRenderFeatureDeclaration(
  feature: RenderFeature<unknown>,
): FullscreenRenderFeatureDeclaration | undefined {
  return (
    feature as RenderFeature<unknown> & {
      readonly [declarationKey]?: FullscreenRenderFeatureDeclaration;
    }
  )[declarationKey];
}

/**
 * Describe a fullscreen effect for the single feature host.
 * The producer returns this closed feature; GPU registration and lifetime stay
 * with the renderer host.
 */
export function createFullscreenRenderFeature(
  options: FullscreenRenderFeatureOptions,
): RenderFeature<boolean | undefined> {
  const resourceName = `fullscreen.${options.identity.replace(/[^a-z0-9.-]/gi, '-').toLowerCase()}`;
  const declaration = Object.freeze({
    identity: options.identity,
    source: options.source,
    ...(options.stage === undefined ? {} : { stage: options.stage }),
    ...(options.reads === undefined
      ? {}
      : {
          reads: Object.freeze(
            options.reads.map((read) =>
              typeof read === 'string' ? read : Object.freeze({ ...read }),
            ),
          ),
        }),
    ...(options.params === undefined
      ? {}
      : {
          params: Object.freeze({
            byteSize: options.params.byteSize,
            defaultValue: options.params.defaultValue.slice(),
          }),
        }),
  });
  const feature = {
    identity: options.identity,
    requiredFullscreenPostProcesses: Object.freeze([
      Object.freeze({ identity: options.identity, source: options.source }),
    ]),
    extract: (context: RenderFeatureExtractContext) => ok(options.enabled?.(context)),
    plan: (enabled: boolean | undefined, _context: RenderFeaturePlanContext) =>
      ok(
        enabled === false
          ? { work: [] }
          : ({
              work: [
                {
                  scope: 'frame',
                  resources: [
                    {
                      kind: 'fullscreen-program',
                      name: resourceName,
                      source: options.source,
                      ...(declaration.stage === undefined ? {} : { stage: declaration.stage }),
                      ...(declaration.reads === undefined ? {} : { reads: declaration.reads }),
                      ...(declaration.params === undefined ? {} : { params: declaration.params }),
                    },
                  ],
                  passes: [],
                },
              ],
            } satisfies RenderFeaturePlan),
      ),
  };
  Object.defineProperty(feature, declarationKey, { value: declaration });
  return Object.freeze(feature);
}
