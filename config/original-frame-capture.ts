import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrameReceipt } from '@forgeax/engine-render';
import type { RecorderAttachment } from '@forgeax/engine-rhi-debug';

const TOTAL_BYTES = 64 * 1024 * 1024;
const CAPTURE_BYTES = 8 * 1024 * 1024;
const METADATA_BYTES = 512 * 1024;
const MAX_SUBMISSIONS = 12;
const RING_SIZE = 8;

export const DAWN_CAPTURE_CASE =
  'packages/modeling/examples/mech-gt/__tests__/s6b-paint.case.dawn.test.ts';

export function selectsDawnCapture(
  selector: string | undefined,
  path: string | undefined,
): boolean {
  return (
    selector === DAWN_CAPTURE_CASE && path?.replaceAll('\\', '/').endsWith(`/${selector}`) === true
  );
}

/** Serialized task errors retain messages without invoking author-defined coercion. */
function failureMessage(cause: unknown): string {
  try {
    if (typeof cause === 'string') return cause.slice(0, 2048);
    if (cause !== null && typeof cause === 'object') {
      const message = Object.getOwnPropertyDescriptor(cause, 'message')?.value;
      const name = Object.getOwnPropertyDescriptor(cause, 'name')?.value;
      if (typeof message === 'string')
        return `${typeof name === 'string' ? name : 'Error'}: ${message}`.slice(0, 2048);
      return '[unprintable failure]';
    }
    return String(cause).slice(0, 2048);
  } catch {
    return '[unprintable failure]';
  }
}

export function originalFailureSummary(cause: unknown): string | readonly string[] {
  try {
    return Array.isArray(cause) ? cause.slice(0, 8).map(failureMessage) : failureMessage(cause);
  } catch {
    return '[unprintable failure]';
  }
}

/** Snapshot timeout belongs to the official recorder, not this metadata walk. */
function metadata(value: unknown): string {
  let nodes = 0;
  let characters = 0;
  const seen = new WeakSet<object>();
  const visit = (child: unknown): unknown => {
    if (++nodes > 2048) return '[metadata-node-budget]';
    if (typeof child === 'string') {
      const length = Math.min(child.length, 2048, Math.max(0, METADATA_BYTES / 8 - characters));
      characters += length;
      return child.slice(0, length);
    }
    if (typeof child === 'bigint') return String(child);
    if (child === null || typeof child !== 'object') return child;
    if (seen.has(child)) return '[cycle]';
    seen.add(child);
    if (ArrayBuffer.isView(child)) return { binaryBytes: child.byteLength };
    if (Array.isArray(child)) return child.slice(0, 128).map(visit);
    const result: Record<string, unknown> = {};
    let keys = 0;
    for (const key in child) {
      if (++keys > 64 || nodes >= 2048 || characters >= METADATA_BYTES / 8) break;
      characters += Math.min(key.length, 256);
      const descriptor = Object.getOwnPropertyDescriptor(child, key);
      if (descriptor !== undefined && 'value' in descriptor)
        result[key.slice(0, 256)] = visit(descriptor.value);
    }
    return result;
  };
  const json = JSON.stringify(visit(value));
  if (json.length <= METADATA_BYTES / 4) return json;
  return JSON.stringify({
    unavailable: 'metadata-byte-budget',
    prefix: json.slice(0, METADATA_BYTES / 8),
  });
}

/** Public inspection facts only; never capture author asset or shader source bytes as JSON. */
function inspectionFacts(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const field = (key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
  return {
    capabilities: field('capabilities'),
    profile: field('profile'),
    limits: field('limits'),
    deviceInfo: field('deviceInfo'),
    frame: field('frame'),
    pipelineLibrary: field('pipelineLibrary'),
    featureGraph: field('featureGraph'),
    recovery: field('recovery'),
  };
}

interface Submission {
  readonly ordinal: number;
  readonly startedAtUnixMs: number;
  capture: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  inspection?: string;
  tape?: Uint8Array;
  closed: boolean;
}

/** First original submissions only. Completion promises are observed, never awaited. */
export class DawnOriginalFrameCapture {
  private readonly abort = new AbortController();
  private readonly entries: Submission[] = [];
  private active: Submission | undefined;
  private allocatedBytes = METADATA_BYTES;
  private failure: string | undefined;
  private admission: string | undefined;

  constructor(
    private readonly recorder: Pick<
      RecorderAttachment,
      'captureFrame' | 'frameBoundary' | 'dispose'
    >,
    private readonly inspect: () => unknown,
    private readonly directory: string,
  ) {}

  async beforeSubmit(): Promise<void> {
    try {
      await this.openSubmission();
    } catch (error) {
      if (this.active !== undefined)
        this.active.capture = { status: 'unavailable', error: failureMessage(error) };
    }
  }

  private async openSubmission(): Promise<void> {
    if (this.entries.length >= MAX_SUBMISSIONS) {
      this.admission = 'submission-limit';
      return;
    }
    if (this.allocatedBytes + METADATA_BYTES >= TOTAL_BYTES) {
      this.admission = 'cumulative-byte-budget';
      return;
    }
    const entry: Submission = {
      ordinal: this.entries.length + 1,
      startedAtUnixMs: Date.now(),
      capture: { status: 'arming', snapshotTimeoutMs: 250 },
      closed: false,
    };
    this.entries.push(entry);
    this.active = entry;
    const budget = Math.min(CAPTURE_BYTES, TOTAL_BYTES - this.allocatedBytes - METADATA_BYTES);
    this.allocatedBytes += METADATA_BYTES;
    if (budget <= 0) {
      entry.capture = { status: 'unavailable', reason: 'cumulative-byte-budget' };
      return;
    }
    this.allocatedBytes += budget;
    const pending = this.recorder.captureFrame({
      byteBudget: budget,
      snapshotTimeoutMs: 250,
      signal: this.abort.signal,
    });
    void pending.then(
      (result) => {
        if (!result.ok) {
          this.allocatedBytes -= budget;
          entry.capture = { status: 'unavailable', error: failureMessage(result.error) };
          return;
        }
        const bytes = result.value.bytes;
        if (bytes.byteLength > budget) {
          this.allocatedBytes -= budget;
          entry.capture = {
            status: 'unavailable',
            reason: 'capture-byte-budget',
            bytes: bytes.byteLength,
            budget,
          };
          return;
        }
        this.allocatedBytes -= budget - bytes.byteLength;
        entry.tape = bytes;
        entry.capture = {
          status: 'captured',
          bytes: bytes.byteLength,
          digest: result.value.digest,
        };
        this.trimTapes();
      },
      (error: unknown) => {
        this.allocatedBytes -= budget;
        entry.capture = { status: 'unavailable', error: failureMessage(error) };
      },
    );
    try {
      const opened = await this.recorder.frameBoundary();
      if (!opened.ok)
        entry.capture = { status: 'unavailable', error: failureMessage(opened.error) };
    } catch (error) {
      entry.capture = { status: 'unavailable', error: failureMessage(error) };
    }
  }

  afterSubmit(
    receipt: Pick<
      FrameReceipt,
      | 'frameId'
      | 'presentation'
      | 'presentationPendingReason'
      | 'completed'
      | 'preparationCompleted'
    >,
  ): void {
    try {
      this.recordReceipt(receipt);
    } catch (error) {
      if (this.active !== undefined)
        this.active.capture = { status: 'unavailable', error: failureMessage(error) };
    } finally {
      if (this.active !== undefined) this.close(this.active);
      this.active = undefined;
    }
  }

  private recordReceipt(
    receipt: Pick<
      FrameReceipt,
      | 'frameId'
      | 'presentation'
      | 'presentationPendingReason'
      | 'completed'
      | 'preparationCompleted'
    >,
  ): void {
    const entry = this.active;
    if (entry === undefined || entry.receipt !== undefined) return;
    const preparation: Record<string, unknown> = { status: 'not-published' };
    const completed: Record<string, unknown> = { status: 'pending' };
    entry.receipt = {
      frameId: receipt.frameId,
      atUnixMs: Date.now(),
      presentation: receipt.presentation,
      pendingReason: receipt.presentationPendingReason,
      preparation,
      completed,
    };
    entry.inspection = metadata(inspectionFacts(this.inspect()));
    this.observe(receipt.completed, completed);
    if (receipt.preparationCompleted !== undefined) {
      preparation.status = 'pending';
      this.observe(receipt.preparationCompleted, preparation);
    }
    this.close(entry);
    this.active = undefined;
  }

  private observe(promise: PromiseLike<unknown>, target: Record<string, unknown>): void {
    void promise.then(
      (result) => Object.assign(target, { status: 'fulfilled', atUnixMs: Date.now(), result }),
      (error: unknown) =>
        Object.assign(target, {
          status: 'rejected',
          atUnixMs: Date.now(),
          error: failureMessage(error),
        }),
    );
  }

  private close(entry: Submission): void {
    if (entry.closed) return;
    entry.closed = true;
    try {
      void this.recorder.frameBoundary().then(
        (result) => {
          if (!result.ok)
            entry.capture = { status: 'unavailable', error: failureMessage(result.error) };
        },
        (error: unknown) => {
          entry.capture = { status: 'unavailable', error: failureMessage(error) };
        },
      );
    } catch (error) {
      entry.capture = { status: 'unavailable', error: failureMessage(error) };
    }
  }

  private trimTapes(): void {
    const tapes = this.entries.filter((entry) => entry.tape !== undefined);
    for (const entry of tapes.slice(0, -RING_SIZE)) {
      delete entry.tape;
      entry.capture = { ...entry.capture, status: 'evicted-from-ring' };
    }
  }

  failed(cause: unknown): void {
    if (this.failure !== undefined) return;
    try {
      this.failure = metadata({
        atUnixMs: Date.now(),
        cause: originalFailureSummary(cause),
        allocatedBytes: this.allocatedBytes,
        admission: this.admission,
        inspection: inspectionFacts(this.inspect()),
        submissions: this.entries.map(
          ({ tape: _tape, inspection: _inspection, ...entry }) => entry,
        ),
      });
    } catch {
      this.failure = metadata({
        cause: originalFailureSummary(cause),
        unavailable: '[inspection unavailable]',
      });
    }
    if (this.active !== undefined) this.close(this.active);
  }

  async writeFailure(): Promise<void> {
    if (this.failure === undefined) return;
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, 'original-submissions.json'), this.failure);
    for (const entry of this.entries) {
      if (entry.tape === undefined) continue;
      await writeFile(
        join(this.directory, `original-submission-${entry.ordinal}.rhitape`),
        entry.tape,
      );
      await writeFile(
        join(this.directory, `original-submission-${entry.ordinal}.json`),
        JSON.stringify({
          ...entry,
          inspection: JSON.parse(entry.inspection ?? 'null'),
          tape: undefined,
        }),
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.active !== undefined) this.close(this.active);
    this.abort.abort();
    await this.recorder.dispose();
  }
}
