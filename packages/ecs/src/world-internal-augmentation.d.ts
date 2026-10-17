// Source-only type augmentation for ECS owner modules and package-owned tests.
// This declaration is included in the ECS TypeScript program but is not
// imported by World, so declaration emit does not make public `world.d.ts`
// depend on the raw world-internal module.
import { type WorldInternal, worldInternal } from './world-internal';
import { type WorldRead, worldRead } from './world-read';

declare module './world' {
  interface World {
    [worldInternal]: WorldInternal;
    // Bind the public capability in the source-only merged type as well.
    // Incremental TypeScript checks can otherwise lose its computed class
    // member after WorldRead changes. World's public declaration stays readonly.
    readonly [worldRead]: WorldRead;
  }
}
