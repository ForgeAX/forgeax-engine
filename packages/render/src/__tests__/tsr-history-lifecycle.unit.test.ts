import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import type { RenderFrameState } from '../record/frame-snapshot';
import type { CameraSnapshot } from '../render-contract';
import {
  abortStagedTemporalGpuState,
  commitTemporalGpuSubmit,
  getTemporalGpuState,
  retireTemporalGpuState,
  stageTemporalGpuSubmit,
} from '../temporal/gpu';
import { inspectTemporal } from '../temporal/inspection';
import { createTemporalView } from '../temporal/view';

it.each([
  false,
  true,
])('admits raster TSR with compute=%s, without storage usage and with the same ten histories', async (compute) => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  Object.defineProperty(device, 'caps', {
    value: { ...device.caps, compute, storageTexture: false, maxColorAttachments: 4 },
  });
  const textures = vi.spyOn(device, 'createTexture');
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(70, 'raster-tsr'),
    97,
    65,
    false,
    { antialias: 'tsr' } as CameraSnapshot,
  );
  try {
    const analysis = state.tsr;
    if (!analysis) throw new Error('missing raster TSR state');
    expect(state.childScope.resourceDelta()).toBe(10);
    expect(textures.mock.calls.every(([descriptor]) => ((descriptor.usage ?? 0) & 8) === 0)).toBe(
      true,
    );
    analysis.pendingInput = [48, 32];
    stageTemporalGpuSubmit(state);
    expect(commitTemporalGpuSubmit(state)).toBe(true);
    expect([state.readIndex, state.valid, state.tsr?.inputWidth]).toEqual([1, true, 48]);
  } finally {
    retireTemporalGpuState(state);
  }
});

it('keeps TSR histories on input-only DRS changes and publishes analysis extents only on submit', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const textures = vi.spyOn(device, 'createTexture');
  const scope = DeviceScope.create(41, 'tsr-owner');
  const frame = {} as RenderFrameState;
  const camera = {
    antialias: 'tsr',
    dynamicResolution: { maxScale: 1, minScale: 0.5, targetGpuMs: 16.67 },
  } as CameraSnapshot;
  const state = getTemporalGpuState(frame, device, scope, 64, 64, false, camera);
  try {
    expect(state.childScope.resourceDelta()).toBe(10);
    expect(textures.mock.calls.map(([d]) => d.format)).toEqual([
      'rgba8unorm',
      'rgba8unorm',
      'rgba16float',
      'rgba16float',
      'rgba16float',
      'rgba16float',
      'rgba16float',
      'rgba16float',
      'rgba8unorm',
      'rgba8unorm',
    ]);
    const analysis = state.tsr;
    if (!analysis) throw new Error('missing TSR state');
    expect(analysis.inputWidth).toBe(0);
    frame.activeTemporalGpuState = state;
    analysis.pendingInput = [32, 32];
    stageTemporalGpuSubmit(state);
    abortStagedTemporalGpuState(frame);
    expect(state.readIndex).toBe(0);
    expect(state.valid).toBe(false);
    expect(analysis.inputWidth).toBe(0);
    expect(analysis.pendingInput).toBeUndefined();
    analysis.pendingInput = [32, 32];
    stageTemporalGpuSubmit(state);
    expect(commitTemporalGpuSubmit(state)).toBe(true);
    expect(state.readIndex).toBe(1);
    expect(analysis.inputWidth).toBe(32);
    const reused = getTemporalGpuState(frame, device, scope, 64, 64, false, camera);
    expect(reused).toBe(state);
    analysis.pendingInput = [48, 48];
    stageTemporalGpuSubmit(state);
    expect(commitTemporalGpuSubmit(state)).toBe(true);
    expect(analysis.width).toBe(64);
    expect(analysis.inputWidth).toBe(48);
    const inspected = inspectTemporal(
      createTemporalView({ antialias: 'tsr', width: 64, height: 64 }),
      undefined,
      { active: state },
    );
    expect(inspected.historyBytes).toBe((40 + 24) * 64 * 64);
    expect(inspected.resources.active).toBe(10);
    expect(
      getTemporalGpuState(frame, device, scope, 64, 64, false, { ...camera, antialias: 'taa' }),
    ).not.toBe(state);
    if (frame.temporalGpuState) retireTemporalGpuState(frame.temporalGpuState);
    expect(getTemporalGpuState(frame, device, scope, 128, 64, false, camera)).not.toBe(state);
    if (frame.temporalGpuState) retireTemporalGpuState(frame.temporalGpuState);
  } finally {
    retireTemporalGpuState(state);
    expect(state.childScope.resourceDelta()).toBe(0);
  }
});

it('keeps native, non-aligned dimensions when DynamicResolution is absent', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(42, 'tsr-native'),
    200,
    150,
    false,
    { antialias: 'tsr' } as CameraSnapshot,
  );
  try {
    expect(state.tsr?.width).toBe(200);
    expect(state.tsr?.height).toBe(150);
  } finally {
    retireTemporalGpuState(state);
  }
});

it('isolates two TSR views and a TAA view, including an aborted write and owner disposal', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const frames = [{}, {}, {}] as RenderFrameState[];
  const states = frames.map((frame, i) =>
    getTemporalGpuState(frame, device, DeviceScope.create(50 + i, `view-${i}`), 64, 64, false, {
      antialias: i === 2 ? 'taa' : 'tsr',
    } as CameraSnapshot),
  );
  const [a, b, c] = states;
  if (!a || !b || !c || !frames[0]) throw new Error('missing view fixture');
  try {
    expect(new Set(states.flatMap((s) => s.color.map((t) => t.texture))).size).toBe(6);
    expect(new Set(states.flatMap((s) => s.tsr?.guide.map((t) => t.texture) ?? [])).size).toBe(4);
    stageTemporalGpuSubmit(b);
    commitTemporalGpuSubmit(b);
    stageTemporalGpuSubmit(a);
    abortStagedTemporalGpuState(frames[0]);
    expect(b.valid).toBe(true);
    expect(b.readIndex).toBe(1);
    expect(c.readIndex).toBe(0);
    retireTemporalGpuState(a);
    expect(b.childScope.resourceDelta()).toBe(10);
    // TAA adds the flickering history pair; TSR does not allocate it.
    expect(c.childScope.resourceDelta()).toBe(8);
  } finally {
    for (const state of states) retireTemporalGpuState(state);
  }
});

it.each([
  ['rgba16floatRenderable', false],
  ['maxColorAttachments', 2],
] as const)('rejects insufficient %s before allocating raster TSR histories', async (capability, value) => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  Object.defineProperty(device, 'caps', {
    value: { ...device.caps, compute: false, storageTexture: false, [capability]: value },
  });
  const create = vi.spyOn(device, 'createTexture');
  expect(() =>
    getTemporalGpuState(
      {} as RenderFrameState,
      device,
      DeviceScope.create(60, 'unsupported'),
      64,
      64,
      false,
      { antialias: 'tsr' } as CameraSnapshot,
    ),
  ).toThrow('TSR requires compute/storage textures or three HDR raster attachments');
  expect(create).not.toHaveBeenCalled();
  // An explicit lightweight choice still works on the same device.
  const taa = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(61, 'taa-fallback'),
    64,
    64,
  );
  retireTemporalGpuState(taa);
});

it('counts the actual half-resolution Cloud histories beside TSR', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const textures = vi.spyOn(device, 'createTexture');
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(62, 'cloud-tsr'),
    200,
    150,
    true,
    { antialias: 'tsr' } as CameraSnapshot,
  );
  try {
    const allocated = textures.mock.calls.reduce((sum, [d]) => {
      const size = d.size as { width: number; height: number };
      return sum + size.width * size.height * (d.format === 'rgba8unorm' ? 4 : 8);
    }, 0);
    expect(
      inspectTemporal(
        createTemporalView({ antialias: 'tsr', width: 200, height: 150 }),
        undefined,
        { active: state },
      ).historyBytes,
    ).toBe(allocated);
  } finally {
    retireTemporalGpuState(state);
  }
});

it('allocates the full authored upper bound even when a fixed scale is between controller grid points', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const state = getTemporalGpuState(
    {} as RenderFrameState,
    device,
    DeviceScope.create(63, 'non-grid-scale'),
    1024,
    1024,
    false,
    {
      antialias: 'tsr',
      dynamicResolution: { minScale: 0.7, maxScale: 0.7, targetGpuMs: 16.67 },
    } as CameraSnapshot,
  );
  try {
    expect([state.tsr?.width, state.tsr?.height]).toEqual([712, 712]);
  } finally {
    retireTemporalGpuState(state);
  }
});

it.each([
  23, 24,
])('uses the actual %s-byte MRT limit before allocating raster TSR', async (bytes) => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  Object.defineProperty(device, 'caps', {
    value: { ...device.caps, compute: false, storageTexture: false },
  });
  Object.defineProperty(device, 'limits', {
    value: { ...device.limits, maxColorAttachmentBytesPerSample: bytes },
  });
  const textures = vi.spyOn(device, 'createTexture');
  const create = () =>
    getTemporalGpuState(
      {} as RenderFrameState,
      device,
      DeviceScope.create(80, 'raster-budget'),
      64,
      64,
      false,
      { antialias: 'tsr' } as CameraSnapshot,
    );
  if (bytes < 24) {
    expect(create).toThrow('TSR requires compute/storage textures or three HDR raster attachments');
    expect(textures).not.toHaveBeenCalled();
  } else {
    const state = create();
    expect(state.tsr).toBeDefined();
    retireTemporalGpuState(state);
  }
});
