import type { Texture } from '@forgeax/engine-rhi';
import type { ShadowViewIdentity } from '../gpu-driven/shadow-views';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { PointShadowSnapshot } from '../render-system-extract';
import type { ViewLights } from '../world/render-lights';
import type { _InternalRenderPipelineContext } from './render-context';

export function shadowUpdatePolicy(
  identity: ShadowViewIdentity,
  lights: ViewLights,
  worlds: readonly RenderResourceScope[],
  effectiveShadowMapSize: number | undefined,
  effectiveSpotShadowMapSize: number | undefined,
  pointShadowTarget: Texture | undefined,
): ReturnType<NonNullable<_InternalRenderPipelineContext['shadowUpdatePolicy']>> {
  const light =
    identity.kind === 'directional'
      ? lights.directional
      : identity.kind === 'point'
        ? lights.pointShadow.find((light) => light.shadowAtlasLayer === identity.index)
        : lights.spot.find((light) => light.shadowAtlasTile === identity.index);
  const policy =
    identity.kind === 'directional'
      ? lights.directionalCsmConfig
      : (light as PointShadowSnapshot | undefined);
  const source = worlds[light !== undefined && 'worldId' in light ? (light.worldId ?? 0) : 0];
  if (policy === undefined || source === undefined) return undefined;
  const aspect = 'shadowMapAspect' in policy ? (policy.shadowMapAspect ?? 1) : 1;
  const size =
    (identity.kind === 'directional' ? effectiveShadowMapSize : effectiveSpotShadowMapSize) ?? 1;
  return {
    blur: {
      radius:
        'shadowRadius' in policy
          ? (policy.shadowRadius ?? 1)
          : ((('pcfKernelSize' in policy ? policy.pcfKernelSize : 3) ?? 3) - 1) / 2,
      samples: policy.shadowBlurSamples ?? 8,
    },
    channels: policy.shadowCasterChannels ?? 0xffffffff,
    auto: policy.shadowAutoUpdate !== false,
    revision: {
      source,
      entity: Number(light?.entity ?? 0),
      revision: policy.shadowRevision ?? 0,
      ...(identity.kind === 'point' ? { target: pointShadowTarget } : {}),
    },
    ...(identity.kind === 'point'
      ? {}
      : {
          viewport: [
            Math.round(size * Math.min(1, aspect)),
            Math.round(size * Math.min(1, 1 / aspect)),
          ] as const,
        }),
  };
}
