import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createViewPipelineState } from '../assembly/view-pipeline-state';
import { createCaptureViewPipeline } from '../capture/capture-view';
import type { DeviceScope } from '../lifecycle';
import { createOutputColorSpaceState } from '../output-color-space';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphState } from '../record/target-capture-graph';
import type { RenderTarget } from '../targets/contracts';
import type { FramebufferSnapshotSource } from '../targets/framebuffer-snapshot';
import { ViewRecorder, type ViewViewport, viewCameraOf } from './render-views';
import type { ViewRecorderState } from './view-output-systems';

/** Scoped recording facts. Shared services remain on the renderer port. */
export const ViewRecordContext = defineComponent('ViewRecordContext', {
  state: 'unique<ViewRecordContext>',
});

/** The unique component payload owns writable view bindings and capture identity. */
export class ViewRecordContextState {
  readonly local: ReturnType<typeof createViewPipelineState>;
  readonly captureView: RenderSystemInternals['captureView'];
  readonly standardPipeline: RenderSystemInternals['standardPipeline'];
  readonly featureHost: RenderSystemInternals['featureHost'];
  featureSceneInputs: RenderSystemInternals['featureSceneInputs'];
  readonly observationCaptureOwner = undefined;
  readonly observationCaptureDomains = undefined;
  readonly sharedFeatureGpuWork: RenderSystemInternals['sharedFeatureGpuWork'];
  readonly outputColorSpace: RenderSystemInternals['outputColorSpace'];
  gpuPassTimingViewId: number | undefined;
  constructor(
    readonly root: RenderSystemInternals,
    readonly entity: EntityHandle,
    readonly deviceScope: DeviceScope,
    readonly camera: number,
    readonly viewport: ViewViewport,
    base: PipelineState,
    capture: CubeCaptureGraphState | undefined,
    target: RenderTarget | undefined,
  ) {
    this.local = createViewPipelineState(base, root, deviceScope);
    this.captureView = capture === undefined ? undefined : { camera, state: capture };
    this.standardPipeline =
      capture === undefined ? root.standardPipeline : createCaptureViewPipeline(capture);
    this.featureHost = capture === undefined ? root.featureHost : undefined;
    this.featureSceneInputs = capture === undefined ? root.featureSceneInputs : undefined;
    this.sharedFeatureGpuWork = root.viewOwner?.preparedResolver.gpuWork;
    this.outputColorSpace =
      target === undefined ? root.outputColorSpace : createOutputColorSpaceState('srgb');
    this.gpuPassTimingViewId = camera;
  }
  private recorder(): ViewRecorderState | undefined {
    const world = this.root.renderWorld;
    if (world === undefined || !world.hasComponent(this.entity, ViewRecorder)) return undefined;
    return world
      .resolveUniqueRef<ViewRecorderState>(world.get(this.entity, ViewRecorder).unwrap().state)
      .unwrap();
  }
  get canvas(): RenderSystemInternals['canvas'] {
    const view = this.recorder();
    if (this.captureView !== undefined) return view?.captureSize ?? { width: 1, height: 1 };
    return (
      viewCameraOf(this.root.renderWorld as World, this.entity)?.extent ??
      view?.output ?? {
        width: this.viewport.renderWidth,
        height: this.viewport.renderHeight,
      }
    );
  }
  get viewOutput(): RenderSystemInternals['viewOutput'] {
    return this.recorder()?.output;
  }
  get deviceGeneration(): number {
    return this.deviceScope.generation;
  }
  readonly getPipelineState = (): PipelineState => this.local.state;
  get growMeshSsbo(): RenderSystemInternals['growMeshSsbo'] {
    return this.local.mesh.growMeshSsbo;
  }
  get meshSsboState(): RenderSystemInternals['meshSsboState'] {
    return this.local.mesh.state;
  }
  invalidateShaderModule(): void {}
  encodeRenderTargetReadbacks(): void {}
  encodeFramebufferSnapshots(encoder: RhiCommandEncoder, source: FramebufferSnapshotSource): void {
    this.root.encodeFramebufferSnapshots?.(encoder, {
      ...source,
      camera: this.camera,
      role: 'view',
    });
  }
}

/** Select the component authority explicitly; a primary or small kernel fixture uses its own port. */
export function recordContext<T extends object>(runtime: T): T {
  return ((runtime as { viewContext?: object }).viewContext ?? runtime) as T;
}
