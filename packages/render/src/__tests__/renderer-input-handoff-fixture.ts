import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { assert, onTestFinished, vi } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program-template';
import * as cameraViewsModule from '../assembly/camera-views';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { CameraView } from '../components/camera-view';
import type { GpuDrivenView } from '../gpu-driven/view-gpu';
import type { GpuScene } from '../gpu-scene';
import type { GpuSceneInputPreparation } from '../gpu-scene-inputs';
import { Materials } from '../materials';
import type { RenderSystemInternals } from '../record/render-context';
import { ViewRecorder } from '../world/render-views';
import type { ViewRecorderState } from '../world/view-output-systems';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

interface RendererInputHandoffOptions {
  /** Disposed by close; the caller retains failed-construction cleanup. */
  readonly assets?: AssetRegistry;
  readonly material?: boolean;
  /** A real Camera-only permanent world, without a dummy or prewarmed native Mesh. */
  readonly residentMesh?: boolean;
  readonly sharedShaderRegistry?: boolean;
  readonly composed?: boolean;
  readonly canvas?: Parameters<typeof createRenderer>[0];
  readonly backend?: Parameters<typeof createRenderer>[3];
  readonly manifestUrl?: string;
  readonly admittedShaderCatalog?: ShaderRegistry;
}

function restoreOnTestFinish(spy: { mockRestore(): unknown }): () => void {
  let pending: typeof spy | undefined = spy;
  const restore = () => {
    const active = pending;
    pending = undefined;
    active?.mockRestore();
  };
  onTestFinished(restore);
  return restore;
}

export async function rendererInputHandoffFixture({
  assets: suppliedAssets,
  material = true,
  residentMesh = true,
  sharedShaderRegistry = false,
  composed = false,
  canvas,
  backend,
  manifestUrl = renderLifecycleManifestUrl(),
  admittedShaderCatalog,
}: RendererInputHandoffOptions = {}) {
  let manager: ReturnType<typeof cameraViewsModule.createCameraViews> | undefined;
  let internals: RenderSystemInternals | undefined;
  const create = cameraViewsModule.createCameraViews;
  const factory = vi.spyOn(cameraViewsModule, 'createCameraViews').mockImplementation((...args) => {
    internals = args[0];
    manager = create(...args);
    return manager;
  });
  const restore = restoreOnTestFinish(factory);
  const host = await createRenderer(
    canvas ?? { width: 64, height: 64, getContext: () => null },
    backend === undefined ? { rhi } : {},
    {
      shaderManifestUrl: manifestUrl,
      prepareShaderProgramCompiler,
      ...(admittedShaderCatalog === undefined ? {} : { admittedShaderCatalog }),
    },
    backend,
  ).finally(restore);
  const initialized = await host.initialization;
  if (!initialized.ok) {
    await host.dispose();
    throw initialized.error;
  }
  assert(manager);
  assert(internals);
  const renderer = exposeRenderer(host);
  const shaderRegistry = sharedShaderRegistry
    ? internals.shaderRegistry
    : new ShaderRegistry({ manifestUrl, prepareProgramCompiler: prepareShaderProgramCompiler });
  assert(shaderRegistry);
  const assets = suppliedAssets ?? new AssetRegistry({ shaderRegistry });
  let resident: GpuScene | undefined;
  const close = async () => {
    const views = new Set<GpuDrivenView>();
    if (resident !== undefined && manager !== undefined && internals?.renderWorld !== undefined) {
      for (const view of manager.currentOwner.gpuDriven.inputBindingViews(resident))
        views.add(view);
      const renderWorld = internals.renderWorld;
      for (const span of renderWorld
        .query({ with: [ViewRecorder] })
        .unwrap()
        .spans()
        .unwrap())
        for (const entity of span.entities) {
          const state = renderWorld
            .resolveUniqueRef<ViewRecorderState>(
              renderWorld.get(entity as EntityHandle, ViewRecorder).unwrap().state,
            )
            .unwrap();
          for (const view of state.owner.gpuDriven.inputBindingViews(resident)) views.add(view);
        }
    }
    try {
      const closed = await host.dispose();
      const retired = await Promise.all([...views].map((view) => view.settleRetirement()));
      if (!closed.ok) return closed;
      for (const result of retired)
        if (!result.ok) return { ok: false as const, error: result.error };
      return closed;
    } finally {
      assets.dispose();
    }
  };
  try {
    const world = new World({ assets });
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    const source = attached.value;
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
          },
        },
        ...(composed ? [{ component: CameraView, data: {} }] : []),
      )
      .unwrap();
    if (residentMesh) {
      const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
      const materialHandle = material
        ? assets
            .create(Materials.standard({ baseColor: [1, 1, 1, 1], emissive: [0.2, 0.4, 0.8] }))
            .unwrap()
        : undefined;
      world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: mesh } },
          {
            component: MeshRenderer,
            data: materialHandle === undefined ? {} : { materials: [materialHandle] },
          },
        )
        .unwrap();
    }
    const draw = async () => {
      world.update(1 / 60).unwrap();
      propagateTransforms(world).unwrap();
      return drawReadyFrame(renderer, { source });
    };
    const initialReceipt = await draw();
    const scene = internals.sceneComposition?.gpuSceneResident;
    assert(scene, 'actual Renderer must own a resident buffer Scene');
    resident = scene;
    return {
      assets,
      manager,
      internals,
      renderer,
      source,
      initialReceipt,
      scene,
      world,
      camera,
      draw,
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

export function finishRendererInput(input: GpuSceneInputPreparation) {
  for (let index = 0; index < 10000; index++)
    if (input.step(64).unwrap().phase === 'current') return;
  throw new Error('Actual Renderer input copy did not finish');
}
