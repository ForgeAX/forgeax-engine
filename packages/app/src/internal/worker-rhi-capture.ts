import { attachRecorder, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import { recordableBackend } from './recordable-rhi';

/** Select the same concrete recorder backend in either Worker rendering tier. */
export async function attachWorkerRhiRecorder(): Promise<RecorderAttachment> {
  const attached = attachRecorder(await recordableBackend());
  if (!attached.ok) throw attached.error;
  return attached.value;
}
