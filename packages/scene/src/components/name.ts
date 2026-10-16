// @forgeax/engine-runtime --- Name component (built-in identifier).
//
// Single-field minimal skeleton: { value: 'string' }. Bare 'string' schema
// vocab keyword routes through ECS UniqueRefStore (D-R3 single-arm managed
// dispatch); the read shape is a native JS string.
//
// Lives in `runtime` rather than `ecs` because Name is a built-in *component*,
// not part of the ECS framework itself (it does not participate in archetype /
// query / world mechanics like the essential `Entity` component does). Mirrors
// Bevy's split: `Entity` lives in `bevy_ecs`; `Name` lives in `bevy_core`.
//
// Migrated from packages/ecs/src/name.ts by tweak-20260612-ecs-concept-compression
// (architecture-principles.md §1 SSOT: Name's authoritative location is the
// runtime built-in components surface, not the ECS framework barrel).
//
// Naming follows the Bevy-aligned convention locked by feat-20260513:
// single-semantic component drops the 'Component' suffix (Transform / Camera
// / DirectionalLight / Name).

import { defineComponent } from '@forgeax/engine-ecs';

export const Name = defineComponent('Name', { value: { type: 'string' } });
