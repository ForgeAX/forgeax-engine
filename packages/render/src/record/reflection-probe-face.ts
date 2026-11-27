import type { BindGroup, RhiRenderPassEncoder, TextureFormat } from '@forgeax/engine-rhi';
import type { CameraSnapshot } from '../render-contract';
import { encodeMainPass } from './main-pass';
import type { _InternalRenderPipelineContext } from './render-context';

/** Both declared and physical faces use the capture view's direct geometry and lighting. */
export function encodeProbeFaceDraws(
  frame: _InternalRenderPipelineContext,
  pass: RhiRenderPassEncoder,
  camera: CameraSnapshot,
  offset: number,
  outputFormat: TextureFormat,
  viewBindGroup: BindGroup | null,
  environmentIbl = frame.environmentIbl,
): void {
  const colorFormat = outputFormat as GPUTextureFormat;
  const capture = {
    ...frame,
    viewBindGroup,
    ...(environmentIbl === undefined ? {} : { environmentIbl }),
    foldDispatchPlan: null,
    camera,
    viewBindGroupDynamicOffset: offset,
    transparentColorFormat: colorFormat,
    msaaActive: false,
    splitLdrSprite: false,
  };
  delete capture.reflectionProbes;
  delete capture.gpuDrivenSelection;
  delete capture.gpuDrivenStandardPbrFrameResources;
  encodeMainPass(capture, pass, undefined, { colorFormats: [colorFormat], passKind: 'forward' });
}
