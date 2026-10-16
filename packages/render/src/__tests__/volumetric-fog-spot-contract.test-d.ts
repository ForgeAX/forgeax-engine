import type { EntityHandle } from '@forgeax/engine-ecs';
import { expectTypeOf } from 'vitest';
import type { VolumetricFogAuthoring } from '../volume/component';

// M6 requires the selected light to be an entity from the same World.  This
// intentionally fails against the pre-M6 optional synthetic-light shape.
expectTypeOf<VolumetricFogAuthoring>().toHaveProperty('light');
expectTypeOf<VolumetricFogAuthoring['light']>().toEqualTypeOf<EntityHandle>();

type CandidateKind = 'directional' | 'spot';
const candidate: CandidateKind = 'spot';
void candidate;

// The old synthetic light API must not be part of the public volume surface.
type Capability = typeof import('../volume/capability');
type SyntheticNames = Extract<
  keyof Capability,
  'VolumetricFogDirectionalLight' | 'VolumetricFogCsmSnapshot' | 'resolveVolumetricFogLight'
>;
const noSyntheticNames: never = null as unknown as SyntheticNames;
void noSyntheticNames;
