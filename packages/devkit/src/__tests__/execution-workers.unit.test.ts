import { afterEach, expect, it, vi } from 'vitest';
import { environmentExecutionWorkers, executionWorkers } from '../execution-workers';

afterEach(() => vi.unstubAllEnvs());

it('forwards combined and partial App policies without selecting a tier', () => {
  for (const policy of [
    {},
    { render: true, kernels: true },
    { engine: false },
    { kernels: 'auto', render: false },
  ]) {
    expect(executionWorkers(policy)).toBe(policy);
    vi.stubEnv('FORGEAX_EXECUTION_WORKERS', JSON.stringify(policy));
    expect(environmentExecutionWorkers()).toEqual(policy);
  }
});

it('defaults ordinary projects to automatic placement', () => {
  vi.stubEnv('FORGEAX_EXECUTION_WORKERS', undefined);
  expect(environmentExecutionWorkers()).toEqual({});
  vi.stubEnv('FORGEAX_EXECUTION_WORKERS', '{}');
  expect(environmentExecutionWorkers()).toEqual({});
});

it.each([
  null,
  'auto',
  [],
  { tier: 'shared' },
  { render: 'true' },
  { kernels: 1 },
])('rejects malformed worker settings %j', (value) => {
  expect(() => executionWorkers(value)).toThrow('workers requires an object');
});
