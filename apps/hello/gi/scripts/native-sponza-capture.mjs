// @ts-check
import { writeFile } from "node:fs/promises";

const MIB = 1024 * 1024;
const MAX_TOTAL_CAPTURE_BUDGET_MIB = 2048;
const MAX_RESOURCE_CAPTURE_BUDGET_MIB = 1024;

/**
 * @param {(name: string, fallback: string) => string} option
 */
export function nativeSponzaCaptureBudgetsFromOptions(option) {
  const totalMiB = Number(option("capture-rhi-byte-budget-mib", "256"));
  const maxResourceMiB = Number(option("capture-rhi-max-resource-mib", "16"));
  /** @type {Array<readonly [string, number, number]>} */
  const validatedBudgets = [
    ["capture-rhi-byte-budget-mib", totalMiB, MAX_TOTAL_CAPTURE_BUDGET_MIB],
    ["capture-rhi-max-resource-mib", maxResourceMiB, MAX_RESOURCE_CAPTURE_BUDGET_MIB],
  ];
  for (const [name, value, maximum] of validatedBudgets) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`--${name} must be an integer from 1 to ${maximum} MiB`);
  }
  if (maxResourceMiB > totalMiB)
    throw new Error("--capture-rhi-max-resource-mib cannot exceed --capture-rhi-byte-budget-mib");
  return {
    totalMiB,
    maxResourceMiB,
    byteBudget: totalMiB * MIB,
    maxResourceBytes: maxResourceMiB * MIB,
  };
}

/**
 * Arm one capture after a completed frame and bracket exactly the following
 * Renderer frame with the recorder's snapshot and completion boundaries.
 *
 * @param {import('@forgeax/engine-rhi-debug').RecorderAttachment} recorder
 * @param {{ outputPath: string; snapshotTimeoutMs: number; byteBudget: number; maxResourceBytes: number }} options
 */
export function createNativeSponzaCapture(recorder, options) {
  /** @type {{ state: 'armed' | 'recording'; requestedAfterFrameId: number; requestedMode: string; promise: ReturnType<typeof recorder.captureFrame> } | undefined} */
  let pending;
  let disposed = false;
  let requested = false;

  const failed = (stage, error, metadata = {}) => ({
    status: "failed",
    stage,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
    ...metadata,
  });

  return {
    rhi: recorder.backend.rhi,
    get idle() {
      return !disposed && !requested;
    },
    requestAfterCompletedFrame(frameId, mode) {
      if (disposed) throw new Error("native Sponza RHI capture is disposed");
      if (requested) throw new Error("native Sponza RHI capture is one-shot");
      requested = true;
      const promise = recorder.captureFrame({
        snapshotTimeoutMs: options.snapshotTimeoutMs,
        byteBudget: options.byteBudget,
        seed: { maxResourceBytes: options.maxResourceBytes },
      });
      pending = {
        state: "armed",
        requestedAfterFrameId: frameId,
        requestedMode: mode,
        promise,
      };
      return {
        status: "armed",
        requestedAfterFrameId: frameId,
        requestedMode: mode,
        outputPath: options.outputPath,
        snapshotTimeoutMs: options.snapshotTimeoutMs,
        byteBudget: options.byteBudget,
        byteBudgetMiB: options.byteBudget / MIB,
        maxResourceBytes: options.maxResourceBytes,
      };
    },
    async beforeNextFrame() {
      const capture = pending;
      if (capture === undefined || capture.state !== "armed") return undefined;
      const boundary = await recorder.frameBoundary();
      if (boundary.ok === false) {
        const result = await capture.promise;
        pending = undefined;
        const error = result.ok === false ? result.error : boundary.error;
        return failed("snapshot", error, {
          requestedAfterFrameId: capture.requestedAfterFrameId,
          requestedMode: capture.requestedMode,
        });
      }
      capture.state = "recording";
      return {
        status: "recording",
        requestedAfterFrameId: capture.requestedAfterFrameId,
        requestedMode: capture.requestedMode,
      };
    },
    async afterFrame(frameId, mode) {
      const capture = pending;
      if (capture === undefined || capture.state !== "recording") return undefined;
      const boundary = await recorder.frameBoundary();
      const result = await capture.promise;
      pending = undefined;
      const metadata = {
        requestedAfterFrameId: capture.requestedAfterFrameId,
        requestedMode: capture.requestedMode,
        frameId,
        mode,
      };
      if (boundary.ok === false) {
        const error = result.ok === false ? result.error : boundary.error;
        return failed("finalize", error, metadata);
      }
      if (result.ok === false) return failed("capture", result.error, metadata);
      try {
        await writeFile(options.outputPath, result.value.bytes, { flag: "wx" });
      } catch (error) {
        return failed("write", error, metadata);
      }
      return {
        status: "captured",
        ...metadata,
        outputPath: options.outputPath,
        byteLength: result.value.byteLength,
        digest: result.value.digest,
      };
    },
    async dispose() {
      if (disposed) return undefined;
      disposed = true;
      const capture = pending;
      pending = undefined;
      const result = await recorder.dispose();
      if (capture !== undefined) {
        const error =
          result.ok === false ? result.error : "capture ended before its frame completed";
        return failed("dispose", error, {
          requestedAfterFrameId: capture.requestedAfterFrameId,
          requestedMode: capture.requestedMode,
        });
      }
      if (result.ok === false) return failed("dispose", result.error);
      return { status: "disposed" };
    },
  };
}
