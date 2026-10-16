/// <reference types="node" />

import { readFileSync } from 'node:fs';
import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { makeRhiDevice, RawDeviceLike } from '../device';

type DeviceLost = Awaited<RhiDevice['lost']>;
type ExpectedDeviceLost = {
  readonly reason: 'destroyed' | 'unknown';
  readonly message: string;
};

const deviceSource = readFileSync(new URL('../device.ts', import.meta.url), 'utf8');

describe('rhi-wgpu device lost owner', () => {
  it('keeps the public loss contract as the single vocabulary owner', () => {
    expectTypeOf<DeviceLost>().toEqualTypeOf<ExpectedDeviceLost>();

    const acceptDeviceLost = (loss: DeviceLost): DeviceLost => loss;
    expect(acceptDeviceLost({ reason: 'destroyed', message: 'released' })).toEqual({
      reason: 'destroyed',
      message: 'released',
    });
    expect(acceptDeviceLost({ reason: 'unknown', message: 'driver reset' })).toEqual({
      reason: 'unknown',
      message: 'driver reset',
    });
    // @ts-expect-error The public loss reason is intentionally closed.
    acceptDeviceLost({ reason: 'driver', message: 'not a public reason' });
  });

  it('preserves the raw string bridge, RhiDevice assignability, and capabilities', () => {
    expectTypeOf<NonNullable<RawDeviceLike['lost']>>().toEqualTypeOf<
      Promise<{ readonly reason: string; readonly message: string }>
    >();
    expectTypeOf<ReturnType<typeof makeRhiDevice>>().toEqualTypeOf<{ device: RhiDevice }>();
    expectTypeOf<ReturnType<typeof makeRhiDevice>['device']['caps']>().toEqualTypeOf<RhiCaps>();
  });

  it('keeps every private view derived from the public owner', () => {
    expect(deviceSource).toContain("type RhiWgpuDeviceLost = Awaited<RhiDevice['lost']>;");
    expect(deviceSource).toContain('readonly lost: Promise<RhiWgpuDeviceLost>;');
    expect(deviceSource).toContain(
      'let lostResolve: ((value: RhiWgpuDeviceLost) => void) | undefined;',
    );
    expect(deviceSource).toContain('new Promise<RhiWgpuDeviceLost>');
    expect(deviceSource).toContain('Promise<RhiWgpuDeviceLost>);');
    expect(deviceSource).toContain("reason: reason as RhiWgpuDeviceLost['reason'], message");
    expect(deviceSource).not.toContain("reason: 'destroyed' | 'unknown'");
  });
});
