import { describe, expect, it } from 'vitest';
import { DEVICE_RESOURCE_KINDS, DeviceScope } from '../device/device-scope';

describe('DeviceScope stale resource matrix', () => {
  it('covers every device-bound resource family through one generation fence', () => {
    const current = DeviceScope.create(40, 'renderer');
    const replacement = DeviceScope.create(41, 'renderer');

    for (const kind of DEVICE_RESOURCE_KINDS) {
      const ref = current.ref(kind, { kind });
      expect(ref.kind).toBe(kind);
      expect(ref.isCurrent(current)).toBe(true);
      expect(ref.isStale(replacement)).toBe(true);
      expect(replacement.accepts(ref)).toBe(false);
    }

    expect(DEVICE_RESOURCE_KINDS).toEqual([
      'device',
      'listener',
      'surface',
      'shader',
      'pipeline',
      'buffer',
      'texture',
      'binding',
      'scene-table',
      'feature',
      'post-effect',
    ]);
  });

  it('does not publish stale alive state after retire or abandon', () => {
    const retired = DeviceScope.create(50, 'renderer');
    retired.retire();
    const abandoned = DeviceScope.create(51, 'renderer');
    abandoned.abandon();

    expect(retired.state).toBe('retired');
    expect(abandoned.state).toBe('abandoned');
    expect(retired.isAlive()).toBe(false);
    expect(abandoned.isAlive()).toBe(false);
  });
});

describe('auto exposure generation fence', () => {
  it('rejects a candidate prepared for a retired device generation', async () => {
    const { createAutoExposureState, prepareAutoExposureCandidate } = await import(
      '../pipeline/standard-output/auto-exposure/state'
    );
    const state = createAutoExposureState({ fallback: 1, targetGeneration: 4, deviceEpoch: 2 });
    if (!state.ok) throw state.error;
    expect(
      prepareAutoExposureCandidate(state.value, {
        ev: 1,
        generation: 4,
        deviceEpoch: 3,
        frameId: 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'auto-exposure-stale-generation' } });
  });
});
