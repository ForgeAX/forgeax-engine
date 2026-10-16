import { parse, validate } from '@forgeax/engine-naga';
import { readbackTexturePixels, type WorkEntry } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok, type Result } from '@forgeax/engine-types';
import { abortedPreviewError, type PreviewError, previewError } from './errors';

type PreviewDevice = Parameters<typeof createShaderModule>[0];
type PreviewTexture = Extract<
  ReturnType<PreviewDevice['createTexture']>,
  { readonly ok: true }
>['value'];

const PREVIEW_WIDTH = 256;
const PREVIEW_HEIGHT = 256;
const PREVIEW_TEXTURE_USAGE = 0x11;

export interface ShaderPreviewStage {
  readonly source: string;
  readonly entryPoint: string | null;
}

/** Static facts copied from the selected producer-owned work entry. */
export type ShaderPreviewWorkFacts = Pick<
  WorkEntry,
  'drawCall' | 'pipeline' | 'bindings' | 'vertexBuffers' | 'indexBuffer' | 'attachments'
>;

export interface ShaderPreviewSelection {
  readonly tapeDigest: string;
  readonly workIndex: number;
  readonly stage: 'vertex' | 'fragment' | 'compute' | null;
  readonly shaderModuleId: string;
  readonly entryPoint: string | null;
  readonly source: string;
  readonly pipelineKind: 'render' | 'compute';
  /** The other raster stage is supplied by the canonical pipeline facts. */
  readonly stages?: {
    readonly vertex?: ShaderPreviewStage;
    readonly fragment?: ShaderPreviewStage;
  };
  /** The selected work facts; no raw tape parsing or viewer-side index is allowed. */
  readonly work?: ShaderPreviewWorkFacts;
  readonly targetFormat?: GPUTextureFormat;
}

export interface ShaderPreviewArtifact {
  readonly provenance: 'preview';
  readonly key: string;
  readonly generation: number;
  readonly source: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly pixelDigest: string;
}

export function makeShaderPreviewKey(selection: ShaderPreviewSelection): string {
  return [
    selection.tapeDigest,
    selection.workIndex,
    selection.stage ?? 'none',
    selection.shaderModuleId,
  ].join('/');
}

export function validateShaderPreviewSelection(
  selection: ShaderPreviewSelection,
): Result<ShaderPreviewSelection, PreviewError> {
  if (selection.pipelineKind !== 'render')
    return err(
      previewError(
        'preview-not-applicable',
        'compute pipelines do not have a selected-raster preview',
        'select a render work item',
      ),
    );
  if (selection.stage === null || selection.stage === 'compute')
    return err(
      previewError(
        'preview-not-applicable',
        'the selected shader has no raster stage',
        'select vertex or fragment',
      ),
    );
  if (selection.entryPoint === null || selection.source.trim() === '')
    return err(
      previewError(
        'preview-not-applicable',
        'the selected shader is incomplete',
        'select a recorded module with a source and entry point',
      ),
    );
  return ok(selection);
}

export interface ShaderPreviewStagePair {
  readonly vertex: { readonly source: string; readonly entryPoint: string };
  readonly fragment: { readonly source: string; readonly entryPoint: string };
}

/** Resolve only canonical paired stages; never synthesize a fallback shader. */
export function selectedRasterStages(
  selection: ShaderPreviewSelection,
): Result<ShaderPreviewStagePair, PreviewError> {
  const vertex =
    selection.stage === 'vertex'
      ? { source: selection.source, entryPoint: selection.entryPoint }
      : selection.stages?.vertex;
  const fragment =
    selection.stage === 'fragment'
      ? { source: selection.source, entryPoint: selection.entryPoint }
      : selection.stages?.fragment;
  if (
    vertex === undefined ||
    fragment === undefined ||
    vertex.source.trim() === '' ||
    fragment.source.trim() === '' ||
    vertex.entryPoint === null ||
    fragment.entryPoint === null
  )
    return err(
      previewError(
        'preview-pipeline-incompatible',
        'the selected raster work has no paired vertex and fragment stage facts',
        'select a pipeline with complete vertex and fragment module sources and entry points',
      ),
    );
  return ok({
    vertex: { source: vertex.source, entryPoint: vertex.entryPoint },
    fragment: { source: fragment.source, entryPoint: fragment.entryPoint },
  });
}

export interface ShaderPreviewApplyOptions {
  readonly webgpuAvailable?: boolean;
  readonly signal?: AbortSignal;
  readonly canvas?: HTMLCanvasElement;
  /** Testable viewer-private backend seam; production uses a fresh WebGPU device. */
  readonly backend?: ShaderPreviewBackend;
}

export interface ShaderPreviewBackend {
  readonly device: PreviewDevice;
  readonly createShaderModule: typeof createShaderModule;
}

export class ShaderPreviewSession {
  private generation = 0;
  private controller: AbortController | null = null;
  private disposed = false;

  async apply(
    selection: ShaderPreviewSelection,
    source: string,
    options: ShaderPreviewApplyOptions = {},
  ): Promise<Result<ShaderPreviewArtifact, PreviewError>> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    const signal = options.signal;
    const isAborted = () => this.disposed || controller.signal.aborted || signal?.aborted === true;

    if (isAborted()) return err(abortedPreviewError());
    const selected = validateShaderPreviewSelection({ ...selection, source });
    if (!selected.ok) return selected;
    if (
      options.backend === undefined &&
      (options.webgpuAvailable === false ||
        typeof navigator === 'undefined' ||
        navigator.gpu === undefined)
    )
      return err(
        previewError(
          'preview-not-applicable',
          'WebGPU is unavailable for the temporary preview session',
          'open the viewer in a WebGPU-capable browser',
        ),
      );

    const parsed = await parse(source);
    if (isAborted()) return err(abortedPreviewError());
    if (!parsed.ok)
      return err(
        previewError('preview-compile-failed', parsed.error.message, parsed.error.hint, {
          ...(parsed.error.lineNum === undefined ? {} : { line: parsed.error.lineNum }),
          ...(parsed.error.linePos === undefined ? {} : { column: parsed.error.linePos }),
        }),
      );
    const validated = await validate(parsed.value);
    if (isAborted()) return err(abortedPreviewError());
    if (!validated.ok)
      return err(
        previewError('preview-validation-failed', validated.error.message, validated.error.hint, {
          ...(validated.error.lineNum === undefined ? {} : { line: validated.error.lineNum }),
          ...(validated.error.linePos === undefined ? {} : { column: validated.error.linePos }),
        }),
      );

    const backendResult =
      options.backend === undefined ? await this.openBackend() : ok(options.backend);
    if (!backendResult.ok) return backendResult;
    if (isAborted()) return err(abortedPreviewError());
    const rendered = await this.renderPreview(selected.value, backendResult.value, isAborted);
    if (!rendered.ok) return rendered;
    if (isAborted()) return err(abortedPreviewError());
    if (options.canvas !== undefined) {
      const presented = presentPreviewCanvas(
        options.canvas,
        rendered.value.pixels,
        PREVIEW_WIDTH,
        PREVIEW_HEIGHT,
      );
      if (!presented.ok) return presented;
    }
    return ok({
      provenance: 'preview',
      key: makeShaderPreviewKey(selected.value),
      generation,
      source,
      width: PREVIEW_WIDTH,
      height: PREVIEW_HEIGHT,
      pixels: rendered.value.pixels,
      pixelDigest: digestPixels(rendered.value.pixels),
    });
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation += 1;
  }

  dispose(): void {
    this.disposed = true;
    this.abort();
  }

  private async openBackend(): Promise<Result<ShaderPreviewBackend, PreviewError>> {
    try {
      const adapter = await rhi.requestAdapter();
      if (!adapter.ok)
        return err(
          previewError(
            'preview-not-applicable',
            `${adapter.error.code}: ${adapter.error.hint}`,
            'open the viewer in a WebGPU-capable browser',
          ),
        );
      const device = await adapter.value.requestDevice();
      if (!device.ok)
        return err(
          previewError(
            'preview-not-applicable',
            `${device.error.code}: ${device.error.hint}`,
            'open the viewer in a WebGPU-capable browser',
          ),
        );
      // A preview owns a fresh device for one Apply. Do not retain it on the
      // session: the temporary pipeline and its device can become unreachable
      // as soon as this Apply settles or is aborted.
      return ok({ device: device.value, createShaderModule });
    } catch (cause) {
      return err(
        previewError(
          'preview-not-applicable',
          cause instanceof Error ? cause.message : String(cause),
          'open the viewer in a WebGPU-capable browser',
        ),
      );
    }
  }

  private async renderPreview(
    selection: ShaderPreviewSelection,
    backend: ShaderPreviewBackend,
    isAborted: () => boolean,
  ): Promise<Result<{ readonly pixels: Uint8Array }, PreviewError>> {
    const work = selection.work;
    if (
      work === undefined ||
      work.pipeline.status !== 'available' ||
      work.pipeline.kind !== 'render'
    )
      return err(
        previewError(
          'preview-not-applicable',
          'the selected work has no complete render pipeline facts',
          'select a raster work with pipeline, attachment, and draw facts',
        ),
      );
    if (work.attachments === null || work.attachments.colorViewHandleIds.length === 0)
      return err(
        previewError(
          'preview-not-applicable',
          'the selected work has no color attachment to preview',
          'select a render work with a captured color attachment',
        ),
      );
    if (work.bindings.length > 0 || work.indexBuffer !== null)
      return err(
        previewError(
          'preview-not-applicable',
          'the selected work requires replayed bindings or an index buffer',
          'select a work whose required resources are represented by the viewer-private preview seam',
        ),
      );

    const topology = renderTopology(work.pipeline.descriptor);
    if (topology === null)
      return err(
        previewError(
          'preview-not-applicable',
          'the selected render pipeline has no supported primitive topology fact',
          'select a render work with a supported raster topology',
        ),
      );

    const stages = selectedRasterStages(selection);
    if (!stages.ok) return stages;

    const drawCall = selectedDrawCall(work.drawCall);
    if (!drawCall.ok) return drawCall;

    const { device } = backend;
    let target: PreviewTexture | undefined;
    try {
      if (isAborted()) return err(abortedPreviewError());
      const vertexModule = await backend.createShaderModule(device, {
        code: stages.value.vertex.source,
      });
      if (!vertexModule.ok)
        return err(
          previewError(
            'preview-compile-failed',
            `${vertexModule.error.code}: ${vertexModule.error.hint}`,
            'fix the vertex WGSL diagnostics, then Apply again',
          ),
        );
      const fragmentModule = await backend.createShaderModule(device, {
        code: stages.value.fragment.source,
      });
      if (!fragmentModule.ok)
        return err(
          previewError(
            'preview-compile-failed',
            `${fragmentModule.error.code}: ${fragmentModule.error.hint}`,
            'fix the fragment WGSL diagnostics, then Apply again',
          ),
        );
      if (isAborted()) return err(abortedPreviewError());

      const format = selection.targetFormat ?? renderTargetFormat(work.pipeline.descriptor);
      if (format === null)
        return err(
          previewError(
            'preview-not-applicable',
            'the selected raster work has no captured color target format',
            'select a render pipeline with a concrete color target format',
          ),
        );
      const texture = device.createTexture({
        size: { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, depthOrArrayLayers: 1 },
        format,
        usage: PREVIEW_TEXTURE_USAGE,
        dimension: '2d',
        mipLevelCount: 1,
        sampleCount: 1,
      });
      if (!texture.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${texture.error.code}: ${texture.error.hint}`,
            'select a renderable color target for the selected pipeline',
          ),
        );
      target = texture.value;
      const targetView = device.createTextureView(target, {
        dimension: '2d',
        aspect: 'all',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      if (!targetView.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${targetView.error.code}: ${targetView.error.hint}`,
            'select a renderable color target for the selected pipeline',
          ),
        );
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: vertexModule.value,
          entryPoint: stages.value.vertex.entryPoint,
          buffers: [],
        },
        fragment: {
          module: fragmentModule.value,
          entryPoint: stages.value.fragment.entryPoint,
          targets: [{ format }],
        },
        primitive: { topology },
      });
      if (!pipeline.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${pipeline.error.code}: ${pipeline.error.hint}`,
            'select a pipeline compatible with the selected work preview facts',
          ),
        );
      const encoder = device.createCommandEncoder({});
      if (!encoder.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${encoder.error.code}: ${encoder.error.hint}`,
            'retry the isolated preview after the device is ready',
          ),
        );
      const pass = encoder.value.beginRenderPass({
        colorAttachments: [
          {
            view: targetView.value,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(pipeline.value);
      pass.draw(
        drawCall.value.vertexCount,
        drawCall.value.instanceCount,
        drawCall.value.firstVertex,
        drawCall.value.firstInstance,
      );
      pass.end();
      const commandBuffer = encoder.value.finish();
      if (!commandBuffer.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${commandBuffer.error.code}: ${commandBuffer.error.hint}`,
            'retry the isolated preview after the device is ready',
          ),
        );
      const submitted = device.queue.submit([commandBuffer.value]);
      if (!submitted.ok)
        return err(
          previewError(
            'preview-pipeline-incompatible',
            `${submitted.error.code}: ${submitted.error.hint}`,
            'retry the isolated preview after the device is ready',
          ),
        );
      await device.queue.onSubmittedWorkDone();
      if (isAborted()) return err(abortedPreviewError());
      const pixels = await readbackTexturePixels(device, target, PREVIEW_WIDTH, PREVIEW_HEIGHT, {
        bytesPerTexel: 4,
        mipLevel: 0,
        baseArrayLayer: 0,
        aspect: 'all',
      });
      return ok({ pixels });
    } catch (cause) {
      if (isAborted()) return err(abortedPreviewError());
      return err(
        previewError(
          'preview-pipeline-incompatible',
          cause instanceof Error ? cause.message : String(cause),
          'select a compatible raster pipeline or reset the editor',
        ),
      );
    } finally {
      if (target !== undefined) device.destroyTexture(target);
    }
  }
}

interface PreviewDrawCall {
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstVertex: number;
  readonly firstInstance: number;
}

function selectedDrawCall(value: unknown): Result<PreviewDrawCall, PreviewError> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return err(
      previewError(
        'preview-not-applicable',
        'the selected work has no structured non-indexed draw facts',
        'select a direct render work with vertexCount and instanceCount',
      ),
    );
  const draw = value as Record<string, unknown>;
  if (draw.kind !== 'draw')
    return err(
      previewError(
        'preview-not-applicable',
        `the selected work uses ${typeof draw.kind === 'string' ? draw.kind : 'an unknown command'} and cannot be reconstructed by the temporary seam`,
        'select a direct non-indexed draw work for local preview',
      ),
    );
  const numberField = (key: string, fallback: number): number | null => {
    const field = draw[key];
    if (field === undefined) return fallback;
    return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : null;
  };
  const vertexCount = numberField('vertexCount', 0);
  const instanceCount = numberField('instanceCount', 1);
  const firstVertex = numberField('firstVertex', 0);
  const firstInstance = numberField('firstInstance', 0);
  if (
    vertexCount === null ||
    instanceCount === null ||
    firstVertex === null ||
    firstInstance === null ||
    vertexCount === 0 ||
    instanceCount === 0
  )
    return err(
      previewError(
        'preview-not-applicable',
        'the selected draw facts are missing a positive vertex or instance count',
        'select a direct draw with complete non-zero counts',
      ),
    );
  return ok({ vertexCount, instanceCount, firstVertex, firstInstance });
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pipelineDescriptor(
  descriptor: ShaderPreviewWorkFacts['pipeline']['descriptor'],
): Record<string, unknown> | null {
  const root = jsonRecord(descriptor);
  return jsonRecord(root?.desc) ?? root;
}

function renderTargetFormat(
  descriptor: ShaderPreviewWorkFacts['pipeline']['descriptor'],
): GPUTextureFormat | null {
  const desc = pipelineDescriptor(descriptor);
  const fragment = jsonRecord(desc?.fragment);
  const targets = Array.isArray(fragment?.targets) ? fragment.targets : [];
  const target = jsonRecord(targets[0]);
  return typeof target?.format === 'string' ? (target.format as GPUTextureFormat) : null;
}

function renderTopology(
  descriptor: ShaderPreviewWorkFacts['pipeline']['descriptor'],
): GPUPrimitiveTopology | null {
  const desc = pipelineDescriptor(descriptor);
  const primitive = jsonRecord(desc?.primitive);
  const topology = primitive?.topology;
  return topology === 'point-list' ||
    topology === 'line-list' ||
    topology === 'line-strip' ||
    topology === 'triangle-list' ||
    topology === 'triangle-strip'
    ? topology
    : null;
}

function presentPreviewCanvas(
  canvas: HTMLCanvasElement,
  pixels: Uint8Array,
  width: number,
  height: number,
): Result<void, PreviewError> {
  const context = canvas.getContext('2d');
  if (context === null)
    return err(
      previewError(
        'preview-pipeline-incompatible',
        'the preview canvas does not expose a 2D presentation context',
        'use a browser canvas that supports 2D presentation',
      ),
    );
  canvas.width = width;
  canvas.height = height;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return ok(undefined);
}

function digestPixels(pixels: Uint8Array): string {
  let hash = 2166136261;
  for (const value of pixels) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}
