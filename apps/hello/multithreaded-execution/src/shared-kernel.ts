import { ExecutionParticleKernelOrder } from "./system-order";
import {
  defineComponent,
  type QuerySpan,
} from '@forgeax/engine-ecs';
import { defineSharedKernel } from '@forgeax/engine-ecs/shared';

export const ExecutionParticle = defineComponent('ExecutionParticle', {
  x: 'f32',
  y: 'f32',
});

export function runExecutionKernel(spans: readonly QuerySpan[]): void {
  for (const span of spans) {
    const particle = span.mut(ExecutionParticle);
    for (let index = 0; index < span.length; index += 1) {
      let x = particle.x[index] ?? 0;
      let y = particle.y[index] ?? 0;
      for (let iteration = 0; iteration < 96; iteration += 1) {
        const next = x * 1.0000001192092896 + y * 0.00031 + iteration * 0.000001;
        y = y * 0.9999999403953552 - x * 0.00017 + iteration * 0.000002;
        x = next;
      }
      particle.x[index] = x;
      particle.y[index] = y;
    }
  }
}

const kernelModule = {
  queries: [{ write: [ExecutionParticle] }],
  run: runExecutionKernel,
} as const;

export function createExecutionKernel(moduleUrl: string) {
  return defineSharedKernel(moduleUrl, {
    ...kernelModule,
    sets: [ExecutionParticleKernelOrder],
    name: 'execution-particle-kernel',
    minimumRows: 1,
  });
}

export default kernelModule;
