import * as files from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createGiEvidenceManifest,
  visibleHdrHasSignal,
  withGiEvidenceOutcome,
} from './gi-evidence-outcome.fixture';

describe('GI evidence outcome', () => {
  function capture() {
    const result: Record<string, unknown> = { status: 'RUNNING' };
    const published: Record<string, unknown>[] = [];
    return {
      result,
      published,
      publish: () => published.push(structuredClone(result)),
      invalidate: () => {
        published.length = 0;
      },
    };
  }

  it('publishes PASS only after validation and cleanup have completed', async () => {
    const h = capture();
    const order: string[] = [];
    await withGiEvidenceOutcome(
      h.result,
      async () => {
        order.push('validated');
        h.result.status = 'PASS';
      },
      async () => {
        order.push('cleaned');
      },
      () => {
        order.push('published');
        h.publish();
      },
      h.invalidate,
    );
    expect(order).toEqual(['validated', 'cleaned', 'published']);
    expect(h.published).toEqual([{ status: 'PASS' }]);
  });

  it('rejects a failed assertion after intermediate signals appeared valid', async () => {
    const h = capture();
    const failure = new Error('Final HDR is black');
    await expect(
      withGiEvidenceOutcome(
        h.result,
        async () => {
          h.result.status = 'PASS';
          throw failure;
        },
        async () => {},
        h.publish,
        h.invalidate,
      ),
    ).rejects.toBe(failure);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.status).not.toBe('PASS');
    expect(h.published[0]?.failure).toMatchObject({ message: failure.message });
  });

  it('records failure before any capture becomes ready', async () => {
    const h = capture();
    const failure = new Error('Capture setup failed');
    await expect(
      withGiEvidenceOutcome(
        h.result,
        async () => {
          throw failure;
        },
        async () => {},
        h.publish,
        h.invalidate,
      ),
    ).rejects.toBe(failure);
    expect(h.published[0]?.status).not.toBe('PASS');
  });

  it('keeps cleanup rejection non-PASS even after all assertions passed', async () => {
    const h = capture();
    const failure = new Error('Recorder disposal failed');
    await expect(
      withGiEvidenceOutcome(
        h.result,
        async () => {
          h.result.status = 'PASS';
        },
        async () => {
          throw failure;
        },
        h.publish,
        h.invalidate,
      ),
    ).rejects.toBe(failure);
    expect(h.published[0]?.status).not.toBe('PASS');
    expect(h.published[0]?.cleanupFailure).toMatchObject({ message: failure.message });
  });

  it('retains validation and cleanup failures together', async () => {
    const h = capture();
    const validation = new Error('Receiver support missing');
    const cleanup = new Error('Harness disposal failed');
    const failure = await withGiEvidenceOutcome(
      h.result,
      async () => {
        h.result.status = 'PASS';
        throw validation;
      },
      async () => {
        throw cleanup;
      },
      h.publish,
      h.invalidate,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([validation, cleanup]);
    expect(h.published[0]?.status).not.toBe('PASS');
  });

  it('does not publish while cleanup remains pending', async () => {
    const h = capture();
    let complete: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const pending = withGiEvidenceOutcome(
      h.result,
      async () => {
        h.result.status = 'PASS';
      },
      async () => gate,
      h.publish,
      h.invalidate,
    );
    await Promise.resolve();
    expect(h.published).toHaveLength(0);
    complete?.();
    await pending;
    expect(h.published[0]?.status).toBe('PASS');
  });
});

describe('visible HDR signal', () => {
  function image() {
    const storage = new Uint8Array(80);
    const bytes = storage.subarray(8, 72);
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const offset of [0, 8, 32, 40]) data.setUint16(offset, 0x3c00, true);
    return {
      bytes,
      data,
      metadata: { width: 2, height: 2, bytesPerRow: 32 },
      covered: new Uint8Array([1, 1, 1, 1]),
    };
  }

  it('reads every covered pixel using row stride and the actual byte offset', () => {
    const h = image();
    expect(visibleHdrHasSignal(h.bytes, h.metadata, h.covered)).toBe(true);
  });

  it('rejects a single black covered pixel even with a bright center/control', () => {
    const h = image();
    h.data.setUint16(40, 0, true);
    expect(visibleHdrHasSignal(h.bytes, h.metadata, h.covered)).toBe(false);
  });

  it.each([0x7c00, 0x7e00, 0xbc00])('rejects an invalid covered channel: %i', (word) => {
    const h = image();
    h.data.setUint16(42, word, true);
    expect(visibleHdrHasSignal(h.bytes, h.metadata, h.covered)).toBe(false);
  });

  it('ignores an uncovered black texel but never accepts empty visibility', () => {
    const h = image();
    h.data.setUint16(40, 0, true);
    h.covered[3] = 0;
    expect(visibleHdrHasSignal(h.bytes, h.metadata, h.covered)).toBe(true);
    h.covered.fill(0);
    expect(visibleHdrHasSignal(h.bytes, h.metadata, h.covered)).toBe(false);
  });
});

describe('GI manifest publication faults', () => {
  const states = ['valid', 'validation', 'cleanup', 'both'] as const;
  const phases = ['publish-before', 'write', 'rename', 'publish-after'] as const;
  const cases = phases.flatMap((phase) =>
    states.flatMap((state) => [false, true].map((stale) => ({ phase, state, stale }))),
  );

  function capture(stale: boolean) {
    const directory = files.mkdtempSync(join(tmpdir(), 'forgeax-gi-publication-'));
    const path = join(directory, 'manifest.json');
    const unrelated = join(directory, 'raw-input.bin');
    files.writeFileSync(unrelated, 'retained raw evidence');
    if (stale) files.writeFileSync(path, JSON.stringify({ status: 'PASS', oldRun: true }));
    return {
      directory,
      path,
      unrelated,
      result: { status: 'RUNNING' } as Record<string, unknown>,
      dispose() {
        // This fresh directory contains only this case's own flat files.
        for (const name of files.readdirSync(directory)) files.unlinkSync(join(directory, name));
        files.rmdirSync(directory);
      },
    };
  }

  it.each(cases)('invalidates final output for $phase/$state/stale=$stale', async ({
    phase,
    state,
    stale,
  }) => {
    const h = capture(stale);
    const validation = new Error('Original HDR validation failed');
    const cleanup = new Error('Original recorder cleanup failed');
    const publicationFailure = new Error(`Injected ${phase} failure`);
    const failValidation = state === 'validation' || state === 'both';
    const failCleanup = state === 'cleanup' || state === 'both';
    const publication = createGiEvidenceManifest(h.path, h.result, {
      ...files,
      writeFileSync(path, data, options) {
        if (phase === 'write') {
          files.writeFileSync(path, '{"status":"PASS"');
          throw publicationFailure;
        }
        files.writeFileSync(path, data, options);
      },
      renameSync(from, to) {
        if (phase === 'rename') throw publicationFailure;
        files.renameSync(from, to);
      },
    });
    try {
      const failure = await withGiEvidenceOutcome(
        h.result,
        async () => {
          if (failValidation) throw validation;
        },
        async () => {
          if (failCleanup) throw cleanup;
        },
        () => {
          if (phase === 'publish-before') throw publicationFailure;
          publication.publish();
          if (phase === 'publish-after') throw publicationFailure;
        },
        publication.invalidate,
      ).catch((error: unknown) => error);
      expect(files.existsSync(h.path), 'failed publication cannot retain a final manifest').toBe(
        false,
      );
      expect(files.readdirSync(h.directory)).toEqual(['raw-input.bin']);
      expect(files.readFileSync(h.unrelated, 'utf8')).toBe('retained raw evidence');
      expect(h.result.status).toBe('PUBLICATION_FAILED');
      expect(h.result.publicationFailure).toMatchObject({ message: publicationFailure.message });
      const expected = [
        ...(failValidation ? [validation] : []),
        ...(failCleanup ? [cleanup] : []),
        publicationFailure,
      ];
      expect(failure instanceof AggregateError ? failure.errors : [failure]).toEqual(expected);
      if (failValidation) expect(h.result.failure).toMatchObject({ message: validation.message });
      if (failCleanup) expect(h.result.cleanupFailure).toMatchObject({ message: cleanup.message });
    } finally {
      h.dispose();
    }
  });

  it.each(
    states.flatMap((state) => [false, true].map((stale) => ({ state, stale }))),
  )('atomically publishes the completed $state outcome/stale=$stale', async ({ state, stale }) => {
    const h = capture(stale);
    const validation = new Error('Retained validation failure');
    const cleanup = new Error('Retained cleanup failure');
    const publication = createGiEvidenceManifest(h.path, h.result);
    try {
      const failure = await withGiEvidenceOutcome(
        h.result,
        async () => {
          if (state === 'validation' || state === 'both') throw validation;
        },
        async () => {
          if (state === 'cleanup' || state === 'both') throw cleanup;
        },
        publication.publish,
        publication.invalidate,
      ).catch((error: unknown) => error);
      const final = JSON.parse(files.readFileSync(h.path, 'utf8'));
      expect(final).toEqual(h.result);
      expect(final.status).toBe(
        state === 'valid'
          ? 'PASS'
          : state === 'validation'
            ? 'VALIDATION_FAILED'
            : 'CLEANUP_FAILED',
      );
      expect(files.readdirSync(h.directory).sort()).toEqual(['manifest.json', 'raw-input.bin']);
      if (state === 'valid') expect(failure).toBeUndefined();
      else
        expect(failure instanceof AggregateError ? failure.errors : [failure]).toEqual([
          ...(state === 'validation' || state === 'both' ? [validation] : []),
          ...(state === 'cleanup' || state === 'both' ? [cleanup] : []),
        ]);
    } finally {
      h.dispose();
    }
  });

  it.each([
    'valid',
    'both',
  ])('invalidates by rewrite when final removal fails: %s', async (state) => {
    const h = capture(false);
    const validation = new Error('Retain original validation');
    const cleanup = new Error('Retain original cleanup');
    const publicationFailure = new Error('Failure after final rename');
    const removalFailure = new Error('Final removal denied');
    const publication = createGiEvidenceManifest(h.path, h.result, {
      ...files,
      rmSync(path, options) {
        if (path === h.path) throw removalFailure;
        files.rmSync(path, options);
      },
    });
    try {
      const failure = await withGiEvidenceOutcome(
        h.result,
        async () => {
          if (state === 'both') throw validation;
        },
        async () => {
          if (state === 'both') throw cleanup;
        },
        () => {
          publication.publish();
          throw publicationFailure;
        },
        publication.invalidate,
      ).catch((error: unknown) => error);
      expect(JSON.parse(files.readFileSync(h.path, 'utf8')).status).toBe('PUBLICATION_FAILED');
      expect(h.result.invalidationFailure).toBeDefined();
      const errors = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(errors) : [error];
      expect(errors(failure)).toEqual([
        ...(state === 'both' ? [validation, cleanup] : []),
        publicationFailure,
        removalFailure,
      ]);
    } finally {
      h.dispose();
    }
  });

  it('awaits an asynchronous publisher failure and invalidates its committed final path', async () => {
    const h = capture(false);
    const publicationFailure = new Error('Async publication rejected after rename');
    const publication = createGiEvidenceManifest(h.path, h.result);
    try {
      await expect(
        withGiEvidenceOutcome(
          h.result,
          async () => {},
          async () => {},
          async () => {
            publication.publish();
            await Promise.resolve();
            throw publicationFailure;
          },
          publication.invalidate,
        ),
      ).rejects.toBe(publicationFailure);
      expect(files.existsSync(h.path)).toBe(false);
      expect(h.result.status).toBe('PUBLICATION_FAILED');
    } finally {
      h.dispose();
    }
  });
});
