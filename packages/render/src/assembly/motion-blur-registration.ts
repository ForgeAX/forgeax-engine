import { MOTION_BLUR_PARAMS_BYTE_SIZE } from '../features/motion-blur/motion-blur-params';
import type { PostProcessShaderEntry } from '../fullscreen-post-process-pass';
import type { RenderSystem } from '../render-system';

export function registerMotionBlurPostProcess(
  renderSystem: Pick<RenderSystem, 'registerBuiltinPostProcess'>,
  source: string,
): void {
  renderSystem.registerBuiltinPostProcess('forgeax.motion-blur', {
    source,
    params: {
      byteSize: MOTION_BLUR_PARAMS_BYTE_SIZE,
      defaultValue: new Uint8Array(MOTION_BLUR_PARAMS_BYTE_SIZE),
    },
    reads: ['scene-color', 'scene-temporal'],
  } satisfies PostProcessShaderEntry);
}
