import { FXAA_POST_PROCESS_ID } from '../render-contract';
import type { RenderSystem } from '../render-system';

/** Register the built-in FXAA post-process once for the active generation. */
export function registerFxaaPostProcess(
  renderSystem: Pick<RenderSystem, 'registerBuiltinPostProcess'>,
  source: string,
  registered: boolean,
): boolean {
  if (registered) return true;
  renderSystem.registerBuiltinPostProcess(FXAA_POST_PROCESS_ID, {
    source,
    params: { byteSize: 16, defaultValue: new Uint8Array(16) },
    reads: ['ldrColor'],
  });
  return true;
}
