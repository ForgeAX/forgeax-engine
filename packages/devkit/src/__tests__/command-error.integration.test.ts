import { build } from 'vite';
import { expect, it } from 'vitest';
import { commandError } from '../project.js';

it('preserves owner recovery fields through the real bundler error envelope', async () => {
  const failure = {
    code: 'source-validation-failed',
    expected: 'valid source inputs',
    hint: 'repair the missing importSettings property',
    detail: { path: 'assets/sky.hdr.meta.json', missingProperty: 'importSettings' },
  };
  let observed: unknown;
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'owner-failure',
          buildStart() {
            this.error(Object.assign(new Error('owner failure'), failure));
          },
        },
      ],
      build: { write: false, rollupOptions: { input: 'package.json' } },
    });
  } catch (cause) {
    observed = commandError(cause, 'game-build-failed');
  }
  expect(observed).toMatchObject(failure);
});

it('retains multiple failures and terminates on cyclic causes', () => {
  const first = { code: 'first', expected: 'first input', hint: 'repair first', detail: {} };
  const second = { code: 'second', expected: 'second input', hint: 'repair second', detail: {} };
  const cause: { errors: unknown[]; cause?: unknown } = { errors: [first, second] };
  cause.cause = cause;
  expect(commandError(cause, 'game-build-failed')).toMatchObject({
    code: 'game-build-failed',
    detail: { failures: [first, second] },
  });
});
