import type { App } from '@forgeax/engine-app';

/** Optional first ordinary-frame evidence; it is not a readiness witness. */
export async function capturePreviewStartupRhi(
  app: Pick<App, 'renderer' | 'rhiCapture'>,
  slug: string,
  signal: AbortSignal,
  emit: (value: Record<string, unknown>) => void,
): Promise<void> {
  const report = (value: Record<string, unknown>): void => {
    try {
      emit({ slug, ...value });
    } catch {
      /* Diagnostics cannot alter startup. */
    }
  };
  try {
    const capture = app.rhiCapture;
    if (capture === undefined) {
      report({ status: 'unavailable', code: 'capture-unavailable' });
      return;
    }
    const initial = app.renderer.inspect();
    if (initial.frame.frameId !== 0) {
      report({
        status: 'unavailable',
        code: 'initial-frame-already-submitted',
        frame: initial.frame,
      });
      return;
    }
    // Called synchronously after app.start, before its first rAF. The existing
    // App front door owns pause/snapshot/resume; no synthetic step is used.
    const pending = capture.captureFrame({
      signal,
      snapshotTimeoutMs: 1000,
      seed: { maxResourceBytes: 0 },
    });
    report({
      status: 'armed',
      backendKind: initial.capabilities.backendKind,
      frames: 1,
      seedMaxResourceBytes: 0,
      scope: 'first ordinary frame; asynchronous initialization may lie outside this tape',
    });
    const captured = await pending;
    if (!captured.ok) {
      report({ status: 'capture-failed', error: captured.error });
      return;
    }
    report({ status: 'captured', byteLength: captured.value.byteLength });
    // Stream the genuine artifact; do not materialize lazy bytes or manufacture
    // a digest. Existing transport verifies the whole tape at commit.
    const uploaded = await capture.upload(captured.value, {
      signal,
      runId: `preview-startup-${crypto.randomUUID()}`,
    });
    report(
      uploaded.ok
        ? { status: 'uploaded', artifact: uploaded.value }
        : { status: 'upload-failed', error: uploaded.error },
    );
  } catch (cause) {
    report({
      status: 'unavailable',
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
