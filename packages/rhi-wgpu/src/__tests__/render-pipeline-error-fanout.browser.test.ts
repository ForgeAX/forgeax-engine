import { describe, expect, it } from 'vitest';
import { createShaderModule, ensureReady, type RhiDevice, requestAdapter } from '../index';

const SHADER = `
  struct VertexOut {
    @builtin(position) position: vec4<f32>,
  }

  @vertex
  fn vs_main() -> VertexOut {
    var output: VertexOut;
    output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return output;
  }

  @fragment
  fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
  }
`;

async function createDevice(canvas: HTMLCanvasElement): Promise<RhiDevice> {
  await ensureReady();
  const adapterResult = await requestAdapter(undefined, canvas);
  if (!adapterResult.ok) throw new Error(JSON.stringify(adapterResult.error));
  const deviceResult = await adapterResult.value.requestDevice();
  if (!deviceResult.ok) throw new Error(JSON.stringify(deviceResult.error));
  return deviceResult.value;
}

describe('wgpu-wasm render pipeline creation error fan-out', () => {
  it('returns creation failure immediately and accepts the next legal pipeline', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    document.body.append(canvas);

    const device = await createDevice(canvas);
    const shaderResult = await createShaderModule(device, {
      label: 'pipeline-error-fanout',
      code: SHADER,
    });
    expect(shaderResult.ok).toBe(true);
    if (!shaderResult.ok) return;

    const layoutResult = device.createPipelineLayout({ bindGroupLayouts: [] });
    expect(layoutResult.ok).toBe(true);
    if (!layoutResult.ok) return;

    const base = {
      layout: layoutResult.value,
      vertex: { module: shaderResult.value, entryPoint: 'vs_main', buffers: [] },
      primitive: { topology: 'triangle-list' as const },
      fragment: {
        module: shaderResult.value,
        targets: [{ format: 'rgba8unorm' as const }],
      },
    };
    const invalid = device.createRenderPipeline({
      ...base,
      fragment: { ...base.fragment, entryPoint: 'missing_fragment' },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe('webgpu-runtime-error');
      expect(invalid.error.hint).toContain('missing_fragment');
    }
    expect(invalid).not.toHaveProperty('value');

    const legal = device.createRenderPipeline(base);
    expect(legal.ok).toBe(true);
    if (legal.ok) expect(legal.value).toBeDefined();
    canvas.remove();
  });
});
