import { Entity, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { DirectionalLight } from '../components/directional-light';
import { PointLight } from '../components/point-light';
import { SpotLight } from '../components/spot-light';

/**
 * The single capability predicate for the authored volumetric-fog producer.
 * Shader sources are part of the device-bound bundle: compute/storage alone
 * is not enough to claim that the three fused graph passes can execute.
 */
export function hasVolumetricFogCapability(
  caps: Pick<RhiCaps, 'compute' | 'storageTexture'>,
  shaders: unknown,
): boolean {
  return caps.compute && caps.storageTexture && shaders !== undefined;
}

export type VolumetricFogLightKind = 'directional' | 'point' | 'spot';
// The exact parity authoring mode is the closed `point-spot` pair.

export type VolumetricFogLightResolution =
  | {
      readonly status: 'available';
      readonly entity: EntityHandle;
      readonly kind: VolumetricFogLightKind;
    }
  | {
      readonly status: 'unresolved';
      readonly reason: 'missing-entity' | 'wrong-component' | 'ambiguous';
      readonly entity: EntityHandle;
      readonly expected: 'DirectionalLight | PointLight | SpotLight';
      readonly actual: string;
      readonly hint: string;
    };

export type VolumetricFogLightPairResolution =
  | {
      readonly status: 'available';
      readonly mode: 'point-spot';
      readonly point: EntityHandle;
      readonly spot: EntityHandle;
    }
  | {
      readonly status: 'unresolved';
      readonly reason: 'missing-entity' | 'same-entity' | 'wrong-component';
      readonly point: EntityHandle;
      readonly spot: EntityHandle;
      readonly expected: 'PointLight + SpotLight in the same World';
      readonly actual: string;
      readonly hint: string;
    };

/** Resolve the narrow official Point+Spot pair without creating a light owner. */
export function resolveVolumetricFogLightPair(
  world: World,
  point: EntityHandle,
  spot: EntityHandle,
): VolumetricFogLightPairResolution {
  const expected = 'PointLight + SpotLight in the same World' as const;
  if (!world.get(point, Entity).ok || !world.get(spot, Entity).ok) {
    return {
      status: 'unresolved',
      reason: 'missing-entity',
      point,
      spot,
      expected,
      actual: 'point or spot entity is absent from this World',
      hint: 'assign two live entities from the same World and retry',
    };
  }
  if (point === spot) {
    return {
      status: 'unresolved',
      reason: 'same-entity',
      point,
      spot,
      expected,
      actual: 'PointLight and SpotLight share one EntityHandle',
      hint: 'spawn PointLight and SpotLight on two different entities',
    };
  }
  const pointValid = world.hasComponent(point, PointLight) && world.hasComponent(point, Transform);
  const spotValid = world.hasComponent(spot, SpotLight) && world.hasComponent(spot, Transform);
  if (!pointValid || !spotValid) {
    return {
      status: 'unresolved',
      reason: 'wrong-component',
      point,
      spot,
      expected,
      actual: `pointValid=${pointValid}; spotValid=${spotValid}`,
      hint: 'attach PointLight and SpotLight with Transform to separate same-World entities',
    };
  }
  return { status: 'available', mode: 'point-spot', point, spot };
}

/**
 * Resolve the required VolumetricFog.light reference in its owning World.
 * PointLight is a valid primary selection for the exact Point+Spot pair.
 * EntityHandle has no portable world tag, so a handle absent from this World
 * (the same World contract) is reported as missing-entity;
 * is reported as missing-entity; callers must not manufacture a light.
 */
export function resolveSelectedVolumetricLight(
  world: World,
  entity: EntityHandle,
): VolumetricFogLightResolution {
  const expected = 'DirectionalLight | PointLight | SpotLight' as const;
  if (!world.get(entity, Entity).ok) {
    return {
      status: 'unresolved',
      reason: 'missing-entity',
      entity,
      expected,
      actual: 'missing or foreign World entity',
      hint: 'assign VolumetricFog.light to a live DirectionalLight or SpotLight in this World',
    };
  }
  const hasDirectional = world.hasComponent(entity, DirectionalLight);
  const hasSpot = world.hasComponent(entity, SpotLight);
  if (hasDirectional && hasSpot) {
    return {
      status: 'unresolved',
      reason: 'ambiguous',
      entity,
      expected,
      actual: 'DirectionalLight + SpotLight',
      hint: 'remove one mutually exclusive light component from the selected entity',
    };
  }
  if (hasDirectional) return { status: 'available', entity, kind: 'directional' };
  if (world.hasComponent(entity, PointLight) && world.hasComponent(entity, Transform)) {
    return { status: 'available', entity, kind: 'point' };
  }
  if (hasSpot && world.hasComponent(entity, Transform)) {
    return { status: 'available', entity, kind: 'spot' };
  }
  const actual = hasSpot
    ? 'SpotLight without Transform'
    : world.hasComponent(entity, PointLight)
      ? 'PointLight'
      : 'other component';
  return {
    status: 'unresolved',
    reason: 'wrong-component',
    entity,
    expected,
    actual,
    hint: 'add exactly one supported light component and a Transform for PointLight or SpotLight in the same World',
  };
}

export interface IntegratedVolumeResource {
  /** Logical resolved-volume identity; this is not a physical graph resource. */
  readonly identity: 'volume-integrated';
  readonly format: 'rgba16float';
  readonly stage: 'resolved';
}

export type VolumeConsumer = 'opaque' | 'transparent' | 'sprite' | 'vfx' | 'custom';

export function resolveIntegratedVolumeConsumer(
  resource: IntegratedVolumeResource,
  consumer: VolumeConsumer,
): { readonly consumer: VolumeConsumer; readonly resource: IntegratedVolumeResource } {
  // The volume owner supplies this prepared logical resource. Consumers only
  // receive its identity and format; they never allocate a view or own the
  // history lifetime here.
  return { consumer, resource };
}
