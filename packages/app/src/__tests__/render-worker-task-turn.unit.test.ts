import { expect, it } from 'vitest';
import { createRenderWorkerTaskTurns } from '../execution/render-worker-task-turn';

it('resumes through a real reusable task source, after promise microtasks', async () => {
  const turns = createRenderWorkerTaskTurns();
  try {
    for (let index = 0; index < 2; index++) {
      let resumed = false;
      const turn = turns.yield().then(() => {
        resumed = true;
      });
      await Promise.resolve();
      expect(resumed).toBe(false);
      await turn;
      expect(resumed).toBe(true);
    }
  } finally {
    turns.dispose();
  }
});

it('owns at most one pending task and releases it on disposal', async () => {
  const turns = createRenderWorkerTaskTurns();
  const turn = turns.yield();
  expect(() => turns.yield()).toThrow('One active Render Worker task turn');
  turns.dispose();
  await turn;
  turns.dispose();
});
