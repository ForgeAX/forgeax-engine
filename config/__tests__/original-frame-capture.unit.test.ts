import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  DAWN_CAPTURE_CASE,
  DawnOriginalFrameCapture,
  originalFailureSummary,
  selectsDawnCapture,
} from '../original-frame-capture';

it('selects only the explicit case and supports native path separators', () => {
  expect(selectsDawnCapture(undefined, `/repo/${DAWN_CAPTURE_CASE}`)).toBe(false);
  expect(selectsDawnCapture(DAWN_CAPTURE_CASE, '/repo/another.dawn.test.ts')).toBe(false);
  expect(
    selectsDawnCapture(DAWN_CAPTURE_CASE, `C:\\repo\\${DAWN_CAPTURE_CASE.replaceAll('/', '\\')}`),
  ).toBe(true);
});

it('does not wait for pending preparation or completion and preserves the original receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-frame-'));
  const frameBoundary = vi.fn(async () => ok(undefined));
  const recorder = {
    captureFrame: vi.fn(() => new Promise<never>(() => {})),
    frameBoundary,
    dispose: vi.fn(async () => ok(undefined)),
  };
  const owner = new DawnOriginalFrameCapture(
    recorder,
    () => ({
      capabilities: { actual: true },
      pipelineLibrary: { pending: { pipelines: ['glass'] } },
    }),
    directory,
  );
  try {
    await owner.beforeSubmit();
    expect(
      owner.afterSubmit({
        frameId: 6,
        presentation: 'pending',
        completed: new Promise<never>(() => {}),
        preparationCompleted: new Promise<never>(() => {}),
      }),
    ).toBeUndefined();
    expect(frameBoundary).toHaveBeenCalledTimes(2);
    owner.failed(new Error('original'));
    await owner.writeFailure();
    const evidence = JSON.parse(
      await readFile(join(directory, 'original-submissions.json'), 'utf8'),
    );
    expect(evidence.cause).toBe('Error: original');
    expect(evidence.submissions[0].receipt).toMatchObject({
      frameId: 6,
      preparation: { status: 'pending' },
      completed: { status: 'pending' },
    });
    expect(evidence.inspection.capabilities).toEqual({ actual: true });
    expect(recorder.captureFrame).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotTimeoutMs: 250, byteBudget: 8 * 1024 * 1024 }),
    );
    await owner.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('isolates diagnostic throws and emits no artifact for a successful case', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-frame-'));
  const recorder = {
    captureFrame: () => {
      throw new Error('capture failed');
    },
    frameBoundary: () => {
      throw new Error('boundary failed');
    },
    dispose: async () => ok(undefined),
  };
  const owner = new DawnOriginalFrameCapture(
    recorder,
    () => {
      throw new Error('inspect failed');
    },
    directory,
  );
  try {
    await expect(owner.beforeSubmit()).resolves.toBeUndefined();
    expect(() =>
      owner.afterSubmit({
        frameId: 6,
        presentation: 'pending',
        completed: new Promise<never>(() => {}),
      }),
    ).not.toThrow();
    await owner.writeFailure();
    expect(await readdir(directory)).toEqual([]);
    expect(() => owner.failed(new Error('original failure'))).not.toThrow();
    owner.failed(new Error('later cleanup error'));
    await owner.writeFailure();
    expect(
      JSON.parse(await readFile(join(directory, 'original-submissions.json'), 'utf8')).cause,
    ).toBe('Error: original failure');
    await owner.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the last eight original tapes and stops after twelve original submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-frame-'));
  type Recorder = ConstructorParameters<typeof DawnOriginalFrameCapture>[0];
  const captureFrame = vi.fn<Recorder['captureFrame']>(async () => {
    const bytes = new Uint8Array([7]);
    return ok({
      bytes,
      byteLength: 1,
      digest: 'fixture-not-a-gpu-tape',
      chunks: () => [{ offset: 0, bytes }],
      get tape(): never {
        throw new Error('logger must not decode fixture bytes');
      },
    });
  });
  const owner = new DawnOriginalFrameCapture(
    { captureFrame, frameBoundary: async () => ok(undefined), dispose: async () => ok(undefined) },
    () => ({ capabilities: { actual: true } }),
    directory,
  );
  try {
    for (let frame = 1; frame <= 14; frame++) {
      await owner.beforeSubmit();
      owner.afterSubmit({
        frameId: frame,
        presentation: 'ready',
        completed: Promise.resolve(ok(undefined)),
      });
    }
    expect(captureFrame).toHaveBeenCalledTimes(12);
    owner.failed(new Error('original assertion'));
    await owner.writeFailure();
    const tapes = (await readdir(directory)).filter((file) => file.endsWith('.rhitape'));
    expect(tapes).toHaveLength(8);
    expect(tapes).toContain('original-submission-6.rhitape');
    expect(tapes).not.toContain('original-submission-4.rhitape');
    const sixth = JSON.parse(await readFile(join(directory, 'original-submission-6.json'), 'utf8'));
    expect(sixth.receipt.frameId).toBe(6);
    expect(sixth.inspection.capabilities).toEqual({ actual: true });
    await owner.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves bounded serialized task messages without invoking custom toString', () => {
  const errors = Array.from({ length: 10 }, (_, index) => ({
    name: 'AssertionError',
    message: `${index}: ${'x'.repeat(3000)}`,
  }));
  const summary = originalFailureSummary(errors);
  expect(summary).toHaveLength(8);
  expect(summary[0]).toContain('AssertionError: 0:');
  expect(summary[7]).toHaveLength(2048);
  expect(
    originalFailureSummary({
      toString() {
        throw new Error('coercion must not run');
      },
    }),
  ).toBe('[unprintable failure]');
});

it('does not replace an original unprintable failure when inspection also throws', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-frame-'));
  const owner = new DawnOriginalFrameCapture(
    {
      captureFrame: () => new Promise<never>(() => {}),
      frameBoundary: async () => ok(undefined),
      dispose: async () => ok(undefined),
    },
    () => {
      throw new Error('inspection failed');
    },
    directory,
  );
  try {
    const original = {
      toString() {
        throw new Error('coercion failed');
      },
    };
    expect(() => owner.failed(original)).not.toThrow();
    await owner.writeFailure();
    const stored = JSON.parse(await readFile(join(directory, 'original-submissions.json'), 'utf8'));
    expect(stored.cause).toBe('[unprintable failure]');
    expect(stored.unavailable).toBe('[inspection unavailable]');
    await owner.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
