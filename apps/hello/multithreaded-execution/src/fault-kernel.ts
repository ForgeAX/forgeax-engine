import type { QuerySpan } from '@forgeax/engine-ecs';
import { ExecutionParticle } from './shared-kernel';

export function runFaultKernel(spans: readonly QuerySpan[]): void {
  const first = spans[0];
  if (first !== undefined && first.length > 0) {
    first.mut(ExecutionParticle).x[0] = 2026;
  }
  throw new Error('intentional partial-write fault');
}

export default { run: runFaultKernel };
