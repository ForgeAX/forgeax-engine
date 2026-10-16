// Render-owned validation failures emitted while projecting render components.

export type RenderValidationErrorCode =
  | 'resource-invalid-value'
  | 'spawn-light-invalid-bounds'
  | 'sprite-instances-count-mismatch'
  | 'sprite-instances-requires-sprite-shader'
  | 'sprite-instances-mutually-exclusive-with-instances';

export {
  ResourceInvalidValueError,
  SpawnLightInvalidBoundsError,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from '@forgeax/engine-ecs/projection';
