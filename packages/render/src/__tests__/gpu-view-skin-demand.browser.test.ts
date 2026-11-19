import { it } from 'vitest';
import { verifyGpuViewSkinDemandBoundary } from './gpu-view-skin-demand.fixture';

it(
  'does not run GPU Skin preparation in rigid views of a skinned Scene',
  verifyGpuViewSkinDemandBoundary,
);
