import { expect, it } from 'vitest';
import { createCleanupEvidenceWriter } from './render-worker-cleanup-evidence';

it('serializes cleanup evidence writes and drains the latest actual stage', async () => {
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  const started: number[] = [];
  const completed: number[] = [];
  let artifact = '';
  const write = createCleanupEvidenceWriter(async (evidence) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    const { stage } = JSON.parse(evidence) as { stage: number };
    started.push(stage);
    if (stage === 0) await first;
    artifact = evidence;
    completed.push(stage);
    active--;
  });
  const writes = Array.from({ length: 10 }, (_, stage) => write(JSON.stringify({ stage })));
  await Promise.resolve();
  const startedBeforeRelease = [...started];
  let drained = false;
  const latest = writes.at(-1);
  if (latest === undefined || releaseFirst === undefined) throw new Error('Missing write fixture');
  const drain = latest.then(() => {
    drained = true;
  });
  await Promise.resolve();
  const drainedBeforeRelease = drained;
  releaseFirst();
  await Promise.all(writes);
  await drain;

  expect(startedBeforeRelease).toEqual([0]);
  expect(drainedBeforeRelease).toBe(false);
  expect(maximumActive).toBe(1);
  expect(completed).toEqual(Array.from({ length: 10 }, (_, stage) => stage));
  expect(JSON.parse(artifact)).toEqual({ stage: 9 });
});

it('preserves a write rejection while allowing the next actual stage to be saved', async () => {
  const failure = new Error('original artifact write failed');
  const started: string[] = [];
  const write = createCleanupEvidenceWriter(async (evidence) => {
    started.push(evidence);
    if (evidence === 'first') throw failure;
  });
  const rejected = write('first').catch((cause: unknown) => cause);
  const next = write('next');
  expect(await rejected).toBe(failure);
  await next;
  expect(started).toEqual(['first', 'next']);
});
