import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { TS_BACKEND_IDENTITY } from './boolean-ts';
import { runChartJob } from './chart-ts';
import type {
  BackendOutput,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  WorkMeter,
} from './job';
import { runSolveJob } from './sparse';
import { runPackJob, runUnwrapJob } from './uv-ts';

/**
 * TypeScript baseline of the solve and UV jobs: CG / Jacobi-PCG / CGLS sparse solves,
 * per-seam LSCM or ExpMap unwrap, skyline pack and PatchBuilder-style charting.
 */
export const tsUvBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) =>
    kind === 'solve.sparse' || kind === 'uv.unwrap' || kind === 'uv.pack' || kind === 'uv.chart',
  quality: () => 'baseline',
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError> {
    const out =
      request.kind === 'solve.sparse'
        ? runSolveJob(request.inputs, (request as ComputeJobRequest<'solve.sparse'>).params, work)
        : request.kind === 'uv.unwrap'
          ? runUnwrapJob(request as ComputeJobRequest<'uv.unwrap'>, work)
          : request.kind === 'uv.pack'
            ? runPackJob(request as ComputeJobRequest<'uv.pack'>, work)
            : runChartJob(request as ComputeJobRequest<'uv.chart'>, work);
    return out as Result<BackendOutput<K>, ModelingError>;
  },
};
