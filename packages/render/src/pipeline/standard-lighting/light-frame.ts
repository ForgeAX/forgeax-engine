import type { Mat4, Vec3 } from '@forgeax/engine-math';
import type {
  DirectionalLightSnapshot,
  PointLightSnapshot,
  RectAreaDirectLightSnapshot,
  SpotLightSnapshot,
} from '../../render-system-extract';
import type { StandardLightCount } from '../standard-profile';

export interface StandardLocalLightInput {
  readonly kind: 'point' | 'spot' | 'rect-area';
  readonly position: Vec3;
  readonly range: number;
  /** Whether the shadow producer admitted this local light to its atlas. */
  readonly shadowed: boolean;
  /**
   * The immutable extract snapshot used by the record payload packer. Keeping
   * it on the POD frame prevents Forward/Deferred from rebuilding a second
   * light list while leaving hand-authored unit fixtures source-free.
   */
  readonly source?: PointLightSnapshot | SpotLightSnapshot | RectAreaDirectLightSnapshot;
}

export interface StandardLightFrame {
  readonly directional: DirectionalLightSnapshot | undefined;
  readonly local: readonly StandardLocalLightInput[];
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly near: number;
  readonly far: number;
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  readonly lightCount: StandardLightCount;
  /** Graph path carried into inspection from the active Standard profile. */
  readonly renderPath: 'forward' | 'deferred';
}
