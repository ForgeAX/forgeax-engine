import { encodeMipmapLevel } from '@forgeax/engine-assets-runtime';
import {
  type CompiledRenderGraph,
  compiledRenderGraphPassDeclarations,
  encodeNativeRenderPass,
  type RenderGraphPassExecution,
  type RenderGraphPassInstrumentation,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder, TextureView } from '@forgeax/engine-rhi';
import { planarReflectionLevels } from '../capture/planar-target';
import { encodeStandardClusterMembership } from '../pipeline/standard-lighting/graph';
import type { StandardTopologyInputValue } from '../pipeline/standard-lighting/topology';
import { recordProbeBackground } from '../reflection/background';
import type { CameraSnapshot } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import { type RenderTargetPhysical, renderTargetMipPhysical } from '../targets/physical';
import type { SharedShadowSource, TypedShadowTargets } from '../typed-shadow-passes';
import type { ReflectionProbeGraphWork } from './frame-graph-history';
import type { ViewBindGroupTargets } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import { encodeProbeFaceDraws } from './reflection-probe-face';
import type { _InternalRenderPipelineContext } from './render-context';
import {
  type CaptureScenePasses,
  type ScenePassRequest,
  scenePassContext,
  scenePassRequests,
} from './scene-pass-work';
import {
  type CubeCaptureGraphWork,
  captureLabel,
  encodeCaptureScenePass,
} from './target-capture-graph';

type PassDeclaration = Pick<RenderGraphPassExecution, 'kind' | 'name'>;
export type CaptureRecording = NativeCaptureRecording | CompiledRenderGraph<RenderPipelineFrame>;

export function captureRecordingPasses(recording: CaptureRecording): readonly PassDeclaration[] {
  return recording instanceof NativeCaptureRecording
    ? recording.declarations()
    : compiledRenderGraphPassDeclarations(recording);
}

export function captureRecordingRequests(recording: CaptureRecording) {
  return recording instanceof NativeCaptureRecording
    ? recording.requests
    : scenePassRequests(recording);
}

type ClusterGrid = StandardTopologyInputValue['prepared']['layout']['grid'];
type ShadowBindings = Pick<ViewBindGroupTargets, 'directionalShadow' | 'spotShadow'>;
type Instrumentation = RenderGraphPassInstrumentation<RenderPipelineFrame> | undefined;

/** Physical capture order is cluster membership, one raster face and any requested mips. */
export abstract class NativeCaptureRecording<
  Requests extends readonly ScenePassRequest[] = readonly ScenePassRequest[],
> {
  constructor(
    readonly requests: Requests,
    readonly generation: number,
    private readonly rasterName: string,
    private readonly cluster: ClusterGrid | undefined,
    private readonly mipPrefix = '',
    private readonly mipCount = 1,
  ) {}

  declarations(): readonly PassDeclaration[] {
    const result: PassDeclaration[] = [];
    if (this.cluster !== undefined)
      result.push({ name: 'cluster-membership-producer', kind: 'compute' });
    result.push({ name: this.rasterName, kind: 'raster' });
    for (let mip = 1; mip < this.mipCount; mip++)
      result.push({ name: this.mipName(mip), kind: 'raster' });
    return result;
  }

  protected mipName(mip: number): string {
    return `${this.mipPrefix}.0-mip-${mip}`;
  }

  abstract shadowTargets(frame: RenderFrameState): ShadowBindings | undefined;

  encode(frame: _InternalRenderPipelineContext, instrumentation: Instrumentation): void {
    const cluster = this.cluster;
    let index = 0;
    if (cluster !== undefined)
      encodeNativeRenderPass(
        frame,
        {
          kind: 'compute',
          name: 'cluster-membership-producer',
          encode: (pass) => encodeStandardClusterMembership(pass, frame, cluster),
        },
        index++,
        instrumentation,
      );
    this.encodeFace(frame, this.rasterName, index, instrumentation);
  }

  protected abstract encodeFace(
    frame: _InternalRenderPipelineContext,
    name: string,
    index: number,
    instrumentation: Instrumentation,
  ): void;
}

/** The face owns its color, depth and resolve views. A planar receiver can borrow
 * the display's issued shadow maps during the synchronous writer callback. */
export class NativeTargetCapture extends NativeCaptureRecording {
  private readonly formats: readonly GPUTextureFormat[];

  constructor(
    private readonly face: CubeCaptureGraphWork,
    private readonly target: RenderTargetPhysical,
    private readonly levels: number,
    cluster: ClusterGrid | undefined,
    private readonly shadow: RenderPipelineTopology['shadow'],
    private readonly shared: SharedShadowSource | undefined,
    scenePasses: CaptureScenePasses,
  ) {
    const name = captureLabel(face);
    super(
      scenePasses.faceRequests(face),
      scenePasses.physicalGeneration,
      `${name}-face.0`,
      cluster,
      name,
      levels,
    );
    this.formats = [target.descriptor.format];
  }

  shadowTargets(): ShadowBindings | undefined {
    if (this.shared === undefined) return undefined;
    const required = (kind: keyof TypedShadowTargets) => {
      const target = this.shared?.current?.[kind];
      if (target === undefined)
        throw new Error(`The display view's ${kind} shadow resolves before its receivers execute`);
      return target.view;
    };
    if (this.shadow.pointCount > 0) required('point');
    return {
      directionalShadow:
        this.shadow.directional === 'disabled' ? undefined : required('directional'),
      spotShadow: this.shadow.spotCount > 0 ? required('spot') : undefined,
    };
  }

  protected encodeFace(
    frame: _InternalRenderPipelineContext,
    name: string,
    index: number,
    instrumentation: Instrumentation,
  ): void {
    const face = this.face;
    const target = this.target;
    const clear = face.faceCamera.clearColor;
    const cube = face.physical.descriptor.shape === 'cube' && face.write === undefined;
    const color = target.layerViews[face.layer];
    const resolve =
      target.descriptor.sampleCount === 4 ? target.resolveLayerViews[face.layer] : undefined;
    if (color === undefined || (target.descriptor.sampleCount === 4 && resolve === undefined))
      throw new Error('Capture writer requires its physical color and resolve layer');
    encodeNativeRenderPass(
      frame,
      {
        kind: 'raster',
        name,
        descriptor: {
          label: name,
          colorAttachments: [
            {
              view: color,
              ...(resolve === undefined ? {} : { resolveTarget: resolve }),
              ...(target.descriptor.shape === '3d' ? { depthSlice: face.layer } : {}),
              clearValue: {
                r: cube ? 0 : (clear[0] ?? 0),
                g: cube ? 0 : (clear[1] ?? 0),
                b: cube ? 0 : (clear[2] ?? 0),
                a: cube ? 1 : (clear[3] ?? 1),
              },
              loadOp: face.write !== undefined && !face.write.clearColor ? 'load' : 'clear',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            view: target.depthView,
            depthClearValue: 0,
            depthLoadOp: face.write !== undefined && !face.write.clearDepth ? 'load' : 'clear',
            depthStoreOp: 'store',
            stencilClearValue: 0,
            stencilLoadOp: face.write !== undefined && !face.write.clearStencil ? 'load' : 'clear',
            stencilStoreOp: 'store',
          },
        },
        encode: (pass: RhiRenderPassEncoder) => {
          for (const request of this.requests)
            encodeCaptureScenePass(
              pass,
              scenePassContext(frame, request),
              face,
              target.descriptor,
              {
                colorFormats: this.formats,
                passKind: 'forward',
                ...(request.recordMode === undefined ? {} : { recordMode: request.recordMode }),
              },
              false,
            );
        },
      },
      index++,
      instrumentation,
    );
    for (let mip = 1; mip < this.levels; mip++) {
      const source = face.physical.mipViews[mip - 1];
      const destination = face.physical.mipViews[mip];
      if (source === undefined || destination === undefined)
        throw new Error('Planar capture requires disjoint views of adjacent resident mip levels');
      const name = this.mipName(mip);
      encodeNativeRenderPass(
        frame,
        {
          kind: 'raster',
          name,
          profileName: 'planar-reflection-mip',
          descriptor: {
            label: name,
            colorAttachments: [
              {
                view: destination,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
              },
            ],
          },
          encode: (pass) => {
            const encoded = encodeMipmapLevel(
              target.device,
              pass,
              source,
              target.descriptor.format,
            );
            if (!encoded.ok) throw encoded.error;
          },
        },
        index++,
        instrumentation,
      );
    }
  }
}

/** Explicit local producers keep their declared accesses. A face with fully owned
 * attachments and lighting records the same concrete draws directly at any change density. */
export function nativeTargetCapture(
  face: CubeCaptureGraphWork,
  scenePasses: CaptureScenePasses,
  lighting: StandardTopologyInputValue,
  shadow: RenderPipelineTopology['shadow'],
  shared: SharedShadowSource | undefined,
): NativeTargetCapture | undefined {
  if ((face.feature?.executions.length ?? 0) > 0 || (face.feature?.plans.length ?? 0) > 0)
    return undefined;
  if (
    shared === undefined &&
    (shadow.directional !== 'disabled' || shadow.pointCount > 0 || shadow.spotCount > 0)
  )
    return undefined;
  const target = renderTargetMipPhysical(face.physical, face.mipLevel ?? 0);
  if (!target.ok) throw target.error;
  const levels = planarReflectionLevels(
    face.physical.device,
    face.faceCamera.planarReflection,
    target.value.descriptor,
  );
  if (levels > 1 && face.physical.device.caps.backendKind === 'wgpu-webgl2') return undefined;
  return new NativeTargetCapture(
    face,
    target.value,
    levels,
    clusterGrid(lighting),
    shadow,
    shared,
    scenePasses,
  );
}

function clusterGrid(lighting: StandardTopologyInputValue): ClusterGrid | undefined {
  return lighting.kind === 'clustered' &&
    lighting.transport.kind === 'compute-storage' &&
    lighting.prepared.local.length > 0
    ? lighting.prepared.layout.grid
    : undefined;
}

/** A raw probe face writes its resident cube layer before any filtering or publication. */
export class NativeProbeCapture extends NativeCaptureRecording<readonly [ScenePassRequest]> {
  constructor(
    private readonly work: ReflectionProbeGraphWork,
    private readonly color: TextureView,
    private readonly camera: CameraSnapshot,
    private readonly offset: number,
    scenePasses: CaptureScenePasses,
    cluster: ClusterGrid | undefined,
  ) {
    super(
      scenePasses.probeRequests,
      scenePasses.physicalGeneration,
      `reflection-probe.${work.probeIndex}.capture.${work.rawCaptureFace}`,
      cluster,
    );
  }

  shadowTargets(frame: RenderFrameState): ShadowBindings {
    return { directionalShadow: frame.frameOutputs.directionalShadowView ?? undefined };
  }

  protected encodeFace(
    frame: _InternalRenderPipelineContext,
    name: string,
    index: number,
    instrumentation: Instrumentation,
  ): void {
    const work = this.work;
    encodeNativeRenderPass(
      frame,
      {
        kind: 'raster',
        name,
        profileName: 'reflection-probe-capture',
        descriptor: {
          label: name,
          colorAttachments: [
            {
              view: this.color,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
          depthStencilAttachment: {
            view: work.rawDepthView,
            depthClearValue: 0,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'store',
          },
        },
        encode: (pass) => {
          const context = scenePassContext(frame, this.requests[0]);
          recordProbeBackground(work.background, context, this.camera, pass);
          encodeProbeFaceDraws(
            context,
            pass,
            this.camera,
            this.offset,
            work.outputFormat,
            context.viewBindGroup,
          );
        },
      },
      index,
      instrumentation,
    );
  }
}

export function nativeProbeCapture(
  work: ReflectionProbeGraphWork,
  scenePasses: CaptureScenePasses,
  lighting: StandardTopologyInputValue,
  shadow: RenderPipelineTopology['shadow'],
): NativeProbeCapture | undefined {
  if (
    work.step !== undefined ||
    work.atmosphere !== undefined ||
    shadow.directional !== 'disabled' ||
    shadow.spotCount > 0 ||
    shadow.pointCount > 0 ||
    work.faceCamera === undefined ||
    work.viewBindGroupDynamicOffset === undefined ||
    work.rawCaptureFace === undefined ||
    !Number.isInteger(work.rawCaptureFace) ||
    work.rawCaptureFace < 0 ||
    work.rawCaptureFace >= 6
  )
    return undefined;
  const color = work.rawFaceViews[work.rawCaptureFace];
  return color === undefined
    ? undefined
    : new NativeProbeCapture(
        work,
        color,
        work.faceCamera,
        work.viewBindGroupDynamicOffset,
        scenePasses,
        clusterGrid(lighting),
      );
}
