import type { Result } from '@forgeax/engine-types';
import type { ModelingError } from '../errors';
import { TS_BACKEND_IDENTITY } from './boolean-ts';
import type {
  BackendOutput,
  ComputeBackend,
  ComputeJobKind,
  ComputeJobRequest,
  WorkMeter,
} from './job';
import { runRemeshJob } from './remesh-ts';
import { runVoxelJob } from './voxel-ts';

/**
 * TypeScript baseline of the mesh-processing jobs: `voxel` (narrow-band SDF and
 * Surface Nets) and `remesh` (QEM simplification and isotropic remeshing).
 */
export const tsProcessBackend: ComputeBackend = {
  name: 'ts',
  identity: TS_BACKEND_IDENTITY,
  supports: (kind: ComputeJobKind) => kind === 'voxel' || kind === 'remesh',
  quality: () => 'baseline',
  run<K extends ComputeJobKind>(
    request: ComputeJobRequest<K>,
    work: WorkMeter,
  ): Result<BackendOutput<K>, ModelingError> {
    const out =
      request.kind === 'voxel'
        ? runVoxelJob(request as ComputeJobRequest<'voxel'>, work)
        : runRemeshJob(request as ComputeJobRequest<'remesh'>, work);
    return out as Result<BackendOutput<K>, ModelingError>;
  },
};
