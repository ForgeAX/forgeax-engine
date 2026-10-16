import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderGraphBuilder, RenderGraphFrame } from '@forgeax/engine-render-graph';
import type { Buffer, TextureView } from '@forgeax/engine-rhi';
import { SceneSdfUnavailableError } from '../errors/scene-sdf';
import type { RenderFeatureSceneResource } from '../features/plan';
import type { RenderFeatureGraphTarget } from '../features/render-graph-raster';
import type { RenderFeatureGraphBufferState } from '../features/render-graph-resources';
import { createRenderFeatureTarget, type RenderFeatureTargetHandle } from '../features/targets';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';
import type { RenderTarget } from '../targets/contracts';
import {
  createRenderTargetPhysical,
  destroyRenderTargetPhysical,
  type RenderTargetPhysical,
  retireRenderTargetPhysical,
} from '../targets/physical';
import { createFeatureSceneSdf, type FeatureSceneSdfSource } from './feature-scene-sdf';

interface DepthInput {
  readonly identity: string;
  readonly serial: number;
  readonly physical: RenderTargetPhysical;
  readonly view: TextureView;
  readonly logical: RenderFeatureTargetHandle;
  readonly target: RenderTarget;
}

/** Frame resources belong to the Renderer, independently of display view cadence. */
export function createFeatureSceneInputs(
  internals: RenderSystemInternals,
  noise: (frame: number) => TextureView | undefined,
) {
  const sdf = createFeatureSceneSdf(internals);
  const depths = new Map<string, DepthInput>();
  const requested = new Map<string, { input: DepthInput; work: CubeCaptureGraphWork }>();
  const failedFeatures = new Set<string>();
  let serial = 0;
  let frame = 0;
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!result.ok) throw result.error;
    return result.value;
  };
  const release = (input: DepthInput) => {
    const result = destroyRenderTargetPhysical(input.physical);
    if (!result.ok) internals.errorRegistry.fire(result.error);
  };
  const retire = (input: DepthInput) => {
    retireRenderTargetPhysical(input.physical, (error) => internals.errorRegistry.fire(error));
  };
  return {
    begin(frameNumber: number) {
      sdf.begin();
      frame = frameNumber;
      if (requested.size > 0) throw new Error('Renderer scene input transaction is still open');
      failedFeatures.clear();
    },
    prepare(
      identity: string,
      resource: RenderFeatureSceneResource,
      source?: FeatureSceneSdfSource,
    ):
      | { view: TextureView; target?: RenderFeatureTargetHandle }
      | { buffer: Buffer; size: number } {
      if (resource.kind === 'scene-sdf') {
        if (source === undefined)
          throw new SceneSdfUnavailableError({ reason: 'missing-source', world: resource.world });
        return sdf.prepare(identity, resource, source);
      }
      if (resource.kind === 'scene-noise') {
        const view = noise(frame);
        if (view === undefined) throw new Error('Renderer scene noise could not be prepared');
        return { view };
      }
      const key = JSON.stringify([identity, resource.name]);
      const width = Math.max(1, internals.canvas.width);
      const height = Math.max(1, internals.canvas.height);
      const device = internals.device;
      let input = requested.get(key)?.input ?? depths.get(key);
      if (
        input !== undefined &&
        (input.physical.device !== device ||
          input.physical.descriptor.width !== width ||
          input.physical.descriptor.height !== height)
      ) {
        input = undefined;
      }
      if (input === undefined) {
        const physical = value(
          createRenderTargetPhysical(
            device,
            {
              shape: '2d',
              width,
              height,
              format: 'rgba8unorm',
              mipLevels: 1,
              sampleCount: 1,
              sampled: false,
              readback: false,
            },
            internals.deviceScope.generation,
            true,
          ),
        );
        const depth = physical.depthTexture;
        let view: TextureView;
        try {
          view = value(device.createTextureView(depth, { dimension: '2d', aspect: 'depth-only' }));
        } catch (error) {
          const released = destroyRenderTargetPhysical(physical);
          if (!released.ok) internals.errorRegistry.fire(released.error);
          throw error;
        }
        input = {
          identity,
          serial: ++serial,
          physical,
          view,
          target: {} as RenderTarget,
          logical: createRenderFeatureTarget({
            name: key,
            kind: 'scene-depth',
            format: 'depth32float-stencil8',
            sampleCount: 1,
          }),
        };
      }
      const { position, right, up, viewProjection } = resource.camera;
      const world = mat4.create();
      world.set([
        right[0] ?? 0,
        right[1] ?? 0,
        right[2] ?? 0,
        0,
        up[0] ?? 0,
        up[1] ?? 0,
        up[2] ?? 0,
        0,
        (right[1] ?? 0) * (up[2] ?? 0) - (right[2] ?? 0) * (up[1] ?? 0),
        (right[2] ?? 0) * (up[0] ?? 0) - (right[0] ?? 0) * (up[2] ?? 0),
        (right[0] ?? 0) * (up[1] ?? 0) - (right[1] ?? 0) * (up[0] ?? 0),
        0,
        position[0] ?? 0,
        position[1] ?? 0,
        position[2] ?? 0,
        1,
      ]);
      const projection = mat4.create();
      mat4.multiply(projection, viewProjection as never, world);
      requested.set(key, {
        input,
        work: {
          target: input.target,
          physical: input.physical,
          layer: 0,
          sceneInput: true,
          faceCamera: {
            ...makeZeroCameraFallbackSnapshot(),
            world,
            captureProjection: projection,
            position: vec3.create(position[0], position[1], position[2]),
            aspect: width / height,
          },
        },
      });
      return { view: input.view, target: input.logical };
    },
    get work(): readonly CubeCaptureGraphWork[] {
      return [...requested.values()].map(({ work }) => work);
    },
    get hasSharedWork(): boolean {
      return sdf.hasSharedWork;
    },
    get topologyKey(): string {
      return JSON.stringify([...requested].map(([key, { input }]) => [key, input.serial]));
    },
    abortFeature(identity: string) {
      sdf.abortFeature(identity);
      failedFeatures.add(identity);
      for (const [key, { input }] of requested) {
        if (input.identity !== identity) continue;
        if (depths.get(key) !== input) release(input);
        requested.delete(key);
      }
    },
    import<Frame extends RenderGraphFrame>(builder: RenderGraphBuilder<Frame>) {
      const targets = new Map<RenderFeatureTargetHandle, RenderFeatureGraphTarget>();
      for (const [key, { input }] of requested) {
        const depth = input.physical.depthTexture;
        const texture = value(
          builder.importTexture(
            `feature-scene-depth:${key}`,
            {
              format: 'depth32float-stencil8',
              size: {
                width: input.physical.descriptor.width,
                height: input.physical.descriptor.height,
              },
              usage: 0x10 | 0x04,
            },
            () => depth,
          ),
        );
        const view = value(
          builder.importView(texture, { aspect: 'depth-only', dimension: '2d' }, () => input.view),
        );
        targets.set(input.logical, { texture, view });
      }
      return targets;
    },
    contribute<Frame extends RenderGraphFrame>(
      builder: RenderGraphBuilder<Frame>,
      state: RenderFeatureGraphBufferState,
    ) {
      sdf.contribute(builder, state);
    },
    detach(scope: import('../publication/resource-scope').RenderResourceScope) {
      sdf.detach(scope);
    },
    complete(submitted: boolean, completion?: Promise<unknown>) {
      sdf.complete(submitted, completion);
      if (submitted) {
        for (const [key, input] of depths) {
          if (requested.get(key)?.input === input || failedFeatures.has(input.identity)) continue;
          retire(input);
          depths.delete(key);
        }
        for (const [key, { input }] of requested) depths.set(key, input);
      } else {
        for (const [key, { input }] of requested) {
          if (depths.get(key) !== input) release(input);
        }
      }
      requested.clear();
      failedFeatures.clear();
    },
    dispose() {
      sdf.dispose();
      for (const [key, { input }] of requested) {
        if (depths.get(key) !== input) release(input);
      }
      for (const input of depths.values()) retire(input);
      depths.clear();
      requested.clear();
      failedFeatures.clear();
    },
  };
}
