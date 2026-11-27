import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import {
  screenProbeWorldRoster,
  screenProbeWorldWgsl,
} from '../../raytracing/screen-probe-kernels';
import { meshDfPolicy } from './mesh-df-approx.fixture';
import {
  softwareDfCandidateControl,
  softwareDfReceiverControl,
} from './software-world-estimator.fixture';

it('uses rendering receiver identity without granting an exact t=0 contact certificate', () => {
  expect(softwareDfReceiverControl()).toEqual({ row: 0, primitive: 17, valid: 1 });
  for (const input of [
    { ready: false },
    { stale: true },
    { opaque: false },
    { associated: false },
    { directory: false },
  ])
    expect(softwareDfReceiverControl(input).valid).toBe(0);
});

it('charges visited candidate tests, not unused capacity or culled directory subtrees', () => {
  const value = softwareDfCandidateControl({ budget: 4 });
  expect(value.result.state).toBe(0);
  expect(value.result.rows).toEqual(Array(32).fill(0));
  expect(value.work).toBe(4); // Three live row tests and the spatially clear root.
  expect(value.remaining).toBe(0);
  expect(value.rawRows).toBe(3);
  expect(value.rawNodes).toBe(1);
  expect(softwareDfCandidateControl({ budget: 3 }).result.state).toBe(3);
  expect(softwareDfCandidateControl({ budget: 0 }).rawRows).toBe(0);
  expect(softwareDfCandidateControl({ budget: 4, stale: true }).result.state).toBe(2);
  expect(softwareDfCandidateControl({ budget: 4, malformed: true }).result.state).toBe(2);
  expect(softwareDfCandidateControl({ budget: 4, capacity: 2 }).result.state).toBe(2);
});

it('compiles the actual Screen World candidate with the original resource ABI and bounded query bank', async () => {
  const strict = screenProbeWorldWgsl('global-sdf');
  const candidate = screenProbeWorldWgsl('global-sdf', false, meshDfPolicy);
  expect(strict).toContain('let contact=screenProbeContact(probe,ray.direction)');
  expect(candidate).not.toContain('fn screenProbeContact(');
  expect(candidate).toContain('let receiver=screenProbeDfReceiver(probe)');
  expect(candidate).toContain('sdfMeshDfWorld(nearRay,nearWorld,&remaining,receiver');
  expect(() => screenProbeWorldWgsl('global-sdf', true, meshDfPolicy)).toThrow();
  expect(() => screenProbeWorldWgsl('ray-query', false, meshDfPolicy)).toThrow();
  const result = await compileShader(candidate, { id: 'screen-world-mesh-df-estimator' });
  expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
  if (!result.ok) return;
  const reflected = result.value.reflection;
  expect(reflected).toBeDefined();
  expect(
    screenProbeWorldRoster('global-sdf').filter(
      ([, type]) => type === 'read' || type === 'storage',
    ),
  ).toHaveLength(8);
});
