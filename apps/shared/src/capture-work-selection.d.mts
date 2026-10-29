import type { FrameModel } from '@forgeax/engine-rhi-debug';

export function selectCaptureWorkIndex(
  model: Pick<FrameModel, 'resources' | 'works'>,
  mode: 'pixel' | 'structural',
  workIndex?: number,
): number | undefined;
