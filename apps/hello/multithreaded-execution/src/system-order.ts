import { defineSystemSet } from '@forgeax/engine-ecs';

/** Stable ordering contracts shared by this owner's system implementations. */
export const ExecutionParticleKernelOrder = defineSystemSet({ name: "execution-particle-kernel" });
