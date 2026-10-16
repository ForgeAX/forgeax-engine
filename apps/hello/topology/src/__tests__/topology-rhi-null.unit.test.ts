import { World } from '@forgeax/engine-ecs';
import {
  createBoxGeometry,
  createWireframeGeometry,
} from '@forgeax/engine-geometry';
import { constructRendererHost } from '@forgeax/engine-render/internal/construct-renderer';
import { Camera, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({
  schemaVersion: '1.0.0',
  entries: [
    { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
    { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
    { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
  ],
  materialShaders: [
    {
      identifier: 'forgeax::default-unlit',
      sourcePath: 'forgeax::default-unlit.wgsl',
      composedWgsl: '/* unlit stub */',
      paramSchema: '[]',
      variants: [],
    },
  ],
}))}`;

function canvas(): HTMLCanvasElement {
  return {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

describe('hello-topology RhiNull structural consumer', () => {
  it('routes public wireframe output to a non-indexed line-list draw', async () => {
    const sourceResult = createBoxGeometry(1.4, 1.4, 1.4);
    expect(sourceResult.ok).toBe(true);
    if (!sourceResult.ok) return;
    const geometryResult = createWireframeGeometry(sourceResult.value);
    expect(geometryResult.ok).toBe(true);
    if (!geometryResult.ok) return;
    const geometry = geometryResult.value;
    const submesh = geometry.submeshes[0];
    expect(submesh).toBeDefined();
    if (submesh === undefined) return;
    expect(submesh.topology).toBe('line-list');
    expect(submesh.indexCount).toBe(0);
    expect(geometry.indices).toBeUndefined();
    expect({ evidence: 'structural-only', pixelVerdict: 'missing' }).toEqual({
      evidence: 'structural-only',
      pixelVerdict: 'missing',
    });

    const hostResult = await constructRendererHost(
      canvas(),
      { rhi },
      { shaderManifestUrl: manifest },
    );
    expect(hostResult.ok).toBe(true);
    if (!hostResult.ok) return;
    const device = hostResult.value.debugDrawHost.device;
    expect(device).toBeInstanceOf(RhiNullDevice);
    if (!(device instanceof RhiNullDevice)) return;
    const pipelineDescriptors: Array<{ readonly topology?: string | undefined }> = [];
    const createPipeline = device.createRenderPipeline.bind(device);
    device.createRenderPipeline = (descriptor) => {
      pipelineDescriptors.push({ topology: descriptor.primitive?.topology });
      return createPipeline(descriptor);
    };

    const world = new World();
    const attached = hostResult.value.renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const meshHandle = world.allocSharedRef('MeshAsset', geometry);
    const materialHandle = world.allocSharedRef('MaterialAsset', {
      kind: 'material',
      passes: [{
        name: 'Forward',
        program: { module: 'forgeax::default-unlit' },
        renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
      }],
      values: { baseColor: [0.1, 0.9, 1.0] },
    });
    const meshEntity = world.spawn(
      { component: Transform, data: { quat: [0, 0, 0, 1] } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    expect(meshEntity.ok).toBe(true);
    if (!meshEntity.ok) return;
    const cameraEntity = world.spawn(
      { component: Transform, data: { pos: [0, 0, 4], quat: [0, 0, 0, 1] } },
      { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 1 }) },
    );
    expect(cameraEntity.ok).toBe(true);
    if (!cameraEntity.ok) return;
    for (let warmup = 0; warmup < 4; warmup += 1) {
      expect(world.update(1 / 60).ok).toBe(true);
      const warmupFrame = hostResult.value.renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(warmupFrame.ok).toBe(true);
      await Promise.resolve();
    }
    device.totalDrawCount = 0;
    expect(world.update(1 / 60).ok).toBe(true);
    const frame = hostResult.value.renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    expect(device.totalDrawCount).toBeGreaterThan(0);
    expect(pipelineDescriptors).toEqual(
      expect.arrayContaining([{ topology: 'line-list' }]),
    );
    expect(hostResult.value.renderer.inspect().perFramePassNames).toContain('main');
    await hostResult.value.renderer.dispose();
  });
});
