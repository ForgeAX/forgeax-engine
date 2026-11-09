import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { UiGpuFrame, UiGpuShaders } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { SurfaceUiFailureCode } from '../../world/surface-ui';
import { createUiCompositor } from '../ui-compositor';

type Source = Parameters<typeof createUiCompositor>[0]['source'];

async function device(): Promise<RhiDevice> {
  const adapter = (await rhi.requestAdapter()).unwrap();
  return (await adapter.requestDevice()).unwrap();
}

async function compositor(source: Source) {
  return createUiCompositor({
    source,
    device: await device(),
    format: 'rgba8unorm',
    retire: (_owner, release) => release(),
    createShaderModule: async (owner, code) =>
      (await rhi.createShaderModule(owner, { code })).unwrap(),
  });
}

const shaders = {
  strip: '',
  clear: '',
  blend: '',
  copy: '',
  filter: '',
} as unknown as UiGpuShaders;

const prepare = (c: Awaited<ReturnType<typeof compositor>>, frame = 7) =>
  c.prepare(frame, 0, 4, 4, 'srgb', false);

function code(outcome: { kind: string; code?: SurfaceUiFailureCode }): string {
  return outcome.kind === 'failed' ? (outcome.code as string) : outcome.kind;
}

describe('UI compositor prepare outcome', () => {
  it('reports painted then retained as data, stamped with the frame', async () => {
    let paints = 0;
    const c = await compositor({
      kind: 'rgba',
      paint: () => (paints++ === 0 ? new Uint8Array(4 * 4 * 4) : null),
    });
    const first = prepare(c, 1);
    expect(first).toMatchObject({ kind: 'painted', frame: 1 });
    const second = prepare(c, 2);
    expect(second).toMatchObject({ kind: 'retained', frame: 2 });
    const encoded = c.encode(2, undefined as never, undefined as never, true);
    expect(encoded.kind).toBe('failed');
    c.dispose();
  });

  it('retains its prepared output when presentation switches between clear and load', async () => {
    const owner = await device();
    const textures = vi.spyOn(owner, 'createTexture');
    const surface = owner
      .createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 0x10 })
      .unwrap();
    const paint = vi.fn(() => new Uint8Array(4 * 4 * 4));
    const c = await createUiCompositor({
      source: { kind: 'rgba', paint },
      device: owner,
      format: 'rgba8unorm',
      retire: (_device, release) => release(),
      createShaderModule: async (target, source) =>
        (await rhi.createShaderModule(target, { code: source })).unwrap(),
    });
    c.prepare(1, 0, 4, 4, 'srgb', true);
    const output = c.output;
    expect(output).toBeDefined();
    const preparedTextures = textures.mock.calls.length;
    for (const [index, clear] of [true, false, true].entries()) {
      c.prepare(index + 2, 0, 4, 4, 'srgb', true);
      const encoder = owner.createCommandEncoder().unwrap();
      expect(c.encode(index + 2, encoder, surface, clear).kind).toBe('encoded');
      owner.queue.submit([encoder.finish().unwrap()]).unwrap();
      expect(c.output).toBe(output);
      expect(textures).toHaveBeenCalledTimes(preparedTextures);
    }
    expect(paint).toHaveBeenCalledTimes(4);
    c.dispose();
    owner.destroyTexture(surface).unwrap();
  });

  it('returns ui-paint-invalid-bytes instead of throwing', async () => {
    const c = await compositor({ kind: 'rgba', paint: () => new Uint8Array(3) });
    const outcome = prepare(c);
    expect(code(outcome)).toBe('ui-paint-invalid-bytes');
    expect(outcome).toMatchObject({ frame: 7 });
    c.dispose();
  });

  it('returns ui-device-operation-failed once disposed instead of throwing', async () => {
    const c = await compositor({ kind: 'rgba', paint: () => null });
    c.dispose();
    expect(code(prepare(c))).toBe('ui-device-operation-failed');
  });

  it('returns ui-paint-extent-mismatch for a sparse-strips frame of the wrong extent', async () => {
    const c = await compositor({
      kind: 'sparse-strips',
      shaders,
      paint: () => ({ width: 2, height: 2 }) as UiGpuFrame,
    });
    expect(code(prepare(c))).toBe('ui-paint-extent-mismatch');
    c.dispose();
  });

  it('returns ui-raster-failed when the raster rejects the frame', async () => {
    const c = await compositor({
      kind: 'sparse-strips',
      shaders,
      paint: () => ({ width: 4, height: 4 }) as UiGpuFrame,
    });
    expect(code(prepare(c))).toBe('ui-raster-failed');
    c.dispose();
  });

  it('returns ui-raster-failed when encoding before any prepare', async () => {
    const c = await compositor({ kind: 'rgba', paint: () => null });
    expect(c.encode(3, undefined as never, undefined as never, true)).toMatchObject({
      kind: 'failed',
      code: 'ui-raster-failed',
      frame: 3,
    });
    c.dispose();
  });
});
