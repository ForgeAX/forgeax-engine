// Source-only type augmentation for ECS owner modules and package-owned tests.
// This declaration is included in the ECS TypeScript program but is not
// imported by World, so declaration emit does not make public `world.d.ts`
// depend on the raw world-internal module.
import { type WorldInternal, worldInternal } from './world-internal';

declare module './world' {
  interface World {
    [worldInternal]: WorldInternal;
  }
}
