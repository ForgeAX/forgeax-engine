import type { VfxGpuEmitterProgram, VfxGpuTickIntent } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  encodeEventInputs,
  eventCapacity,
  eventInputCapacity,
  VFX_EVENT_INPUT_BYTES,
} from '../feature/event-resources.js';

const emitter = {
  id: 'mouth-charge',
  capacity: 5,
  backend: { required: 'gpu' },
  space: 'world',
  schedule: { rate: 1 },
  bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
  renderers: [{ kind: 'billboard', material: 'material-guid' }],
  channels: [
    { id: 'impact', capacity: 3, overflow: 'drop-oldest' },
    { id: 'spark', capacity: 4, overflow: 'drop-newest' },
  ],
  events: [
    {
      id: 'impact-event',
      channel: 'impact',
      subEmitter: 'impact-mesh',
      fanOut: 2,
      recursionDepth: 1,
    },
  ],
  simulationWhenCulled: 'continue',
  wgsl: 'cooked',
  reflection: {
    hooks: ['vfx_spawn', 'vfx_update'],
    imports: [],
    resources: [],
    entryPoints: [],
    bindings: [],
  },
} as unknown as VfxGpuEmitterProgram;

describe('GPU event resources', () => {
  it('derives bounded input and output capacities from reflected channels', () => {
    expect(eventInputCapacity(emitter)).toBe(7);
    expect(eventCapacity(emitter)).toBe(5);
  });

  it('encodes inputs in stable order and fills unused slots with a sentinel', () => {
    const intent = {
      emitter,
      channelInputs: [
        {
          channel: 'impact',
          payload: { position: [1, 2, 3], strength: 0.5 },
          sequence: 11,
        },
      ],
    } as unknown as VfxGpuTickIntent;
    const encoded = encodeEventInputs(intent);
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

    expect(encoded.byteLength).toBe(7 * VFX_EVENT_INPUT_BYTES);
    expect(view.getFloat32(0, true)).toBe(1);
    expect(view.getFloat32(4, true)).toBe(2);
    expect(view.getFloat32(8, true)).toBe(3);
    expect(view.getFloat32(16, true)).toBe(0.5);
    expect(view.getUint32(20, true)).toBe(11);
    expect(view.getUint32(28, true)).toBe(2);
    expect(encoded[32]).toBe(0xff);
  });
});
