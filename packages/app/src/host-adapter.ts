// Optional browser capabilities exposed to explicit host/tool adapters.
// This module does not inspect build-tool metadata or ambient process state.

import type { RendererOptions } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import {
  installBrowserExecutionBridge,
  installBrowserRemoteBridge,
} from './internal/browser-remote-bridge';
import { recordableBackend } from './internal/recordable-rhi';

/** Attach the optional recorder using the backend selected for this renderer. */
export async function attachBrowserRhiRecorder(
  rendererOptions: RendererOptions,
): Promise<RecorderAttachment> {
  const attached = attachRecorder(await recordableBackend(rendererOptions));
  if (!attached.ok) throw new Error(attached.error.hint);
  return attached.value;
}

export { installBrowserExecutionBridge, installBrowserRemoteBridge };
