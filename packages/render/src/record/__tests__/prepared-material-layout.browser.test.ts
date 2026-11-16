import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { _internal_getRawDevice, disposeDevice, requestAdapter } from '@forgeax/engine-rhi-webgpu';
import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { transmissionBackdropAvailable } from '../../assembly/device-feature-admission';
import { createSkylightFallback } from '../../ibl/skylight-bind-group';
import { buildBindGroupLayoutDescriptor } from '../../pbr-pipeline';
import { worldRenderResources } from '../../publication/resource-scope';
import { preparedMaterialBindings } from '../prepared-material-bindings';
import type { RenderSystemInternals } from '../render-context';

it.each([
  { name: 'empty', schema: [] },
  { name: 'texture-only', schema: [{ name: 'map', type: 'texture2d' }] },
  { name: 'numeric', schema: [{ name: 'roughness', type: 'f32' }] },
] satisfies Array<{
  name: string;
  schema: ParamSchemaEntry[];
}>)('validates prepared $name material bindings against the actual PBR layout', async ({
  schema,
}) => {
  const device = (await (await requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = _internal_getRawDevice(device);
  if (raw === undefined) throw new Error('native WebGPU device unavailable');
  const assets = new AssetRegistry();
  const world = new World({ assets });
  try {
    const fallback = createSkylightFallback(device, device.queue);
    const storage = device.createBuffer({ size: 256, usage: 128 }).unwrap();
    const handle = assets
      .create({
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'game::prepared-layout' } }],
        values: { roughness: 0.25 },
      })
      .unwrap();
    const layout = device
      .createBindGroupLayout(
        buildBindGroupLayoutDescriptor(
          {
            shader: { id: 'game::prepared-layout', passKind: 'forward', variantSet: undefined },
            attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
            geometry: { topology: 'triangle-list', vertexLayout: {} },
            renderState: undefined,
          },
          {
            kind: 'pbr-material-merged',
            materialParamSchema: schema,
            caps: {
              storageBuffer: device.caps.storageBuffer,
              transmissionBackdrop: transmissionBackdropAvailable(
                device.limits.maxSampledTexturesPerShaderStage,
              ),
            },
          },
        ),
      )
      .unwrap();
    const runtime = {
      assets,
      device,
      getParamSchema: () => schema,
      getPipelineState: () => ({
        defaultSampler: fallback.sampler,
        defaultWhiteTextureView: fallback.brdfLutView,
        skylightFallback: fallback,
        meshStorageBuffer: { buffer: storage },
      }),
    } as unknown as RenderSystemInternals;
    raw.pushErrorScope('validation');
    const binding = preparedMaterialBindings(
      runtime,
      worldRenderResources(world),
      'game::prepared-layout',
      handle,
      layout,
    ).unwrap();
    const error = await raw.popErrorScope();
    expect(error?.message).toBeUndefined();
    expect('dynamicOffsets' in binding && binding.dynamicOffsets).toEqual([0]);
    if ('release' in binding) binding.release?.();
  } finally {
    assets.dispose();
    disposeDevice(device);
  }
}, 30_000);
