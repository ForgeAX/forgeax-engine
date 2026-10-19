import {
  blitMipmapsSync,
  getOrCreateMipmapPipeline,
} from '@forgeax/engine-assets-runtime';

// The generator copies each rendered level into the target.
const TEXTURE_BINDING_AND_COPY_DST = 0x04 | 0x02;

export interface MipmapPipelineProbeResult {
  readonly schema: 'forgeax.mipmap-pipeline-probe/1';
  readonly status: 'pass' | 'fail';
  readonly stage: 'module-and-pipeline' | 'render-submit' | 'complete' | 'setup';
  readonly backendKind: string | null;
  readonly pipelineCreated: boolean;
  readonly pipelineFormats: readonly string[];
  readonly error?: Record<string, unknown>;
}

function projectError(error: unknown): Record<string, unknown> {
  if (error === null || typeof error !== 'object') return { message: String(error) };
  const value = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
    readonly message?: unknown;
    readonly cause?: unknown;
  };
  return {
    code: value.code ?? null,
    expected: value.expected ?? null,
    hint: value.hint ?? null,
    detail: value.detail ?? null,
    message: value.message ?? null,
    cause: value.cause ?? null,
  };
}

function publish(result: MipmapPipelineProbeResult): void {
  const host = globalThis as typeof globalThis & {
    __forgeaxMipmapProbeResult?: MipmapPipelineProbeResult;
  };
  host.__forgeaxMipmapProbeResult = Object.freeze(result);
  console.info(`__forgeaxMipmapProbe:${JSON.stringify(result)}`);
}

function fail(
  stage: MipmapPipelineProbeResult['stage'],
  backendKind: string | null,
  pipelineCreated: boolean,
  pipelineFormats: readonly string[],
  error: unknown,
): MipmapPipelineProbeResult {
  return {
    schema: 'forgeax.mipmap-pipeline-probe/1',
    status: 'fail',
    stage,
    backendKind,
    pipelineCreated,
    pipelineFormats,
    error: projectError(error),
  };
}

/**
 * Exercise the canonical runtime mipmap module/BGL/pipeline on the real
 * wgpu WebGL2 backend. The render submit is intentional: wgpu may defer WGSL
 * stage validation until a command is submitted, so pipeline construction
 * alone is not sufficient evidence that the contract is valid.
 */
export async function runMipmapPipelineProbe(canvas: HTMLCanvasElement): Promise<void> {
  let backendKind: string | null = null;
  let pipelineCreated = false;
  const pipelineFormats: string[] = [];
  try {
    const [{ ensureReady, requestAdapter, createShaderModule }] = await Promise.all([
      import('@forgeax/engine-rhi-wgpu'),
    ]);
    await ensureReady();
    const adapterResult = await requestAdapter(undefined, canvas);
    if (!adapterResult.ok) {
      publish(fail('setup', backendKind, pipelineCreated, pipelineFormats, adapterResult.error));
      return;
    }
    const deviceResult = await adapterResult.value.requestDevice();
    if (!deviceResult.ok) {
      publish(fail('setup', backendKind, pipelineCreated, pipelineFormats, deviceResult.error));
      return;
    }
    const device = deviceResult.value;
    backendKind = device.caps.backendKind;

    const formats = ['rgba8unorm-srgb', 'rgba8unorm'] as const;
    for (const format of formats) {
      const pipelineResult = await getOrCreateMipmapPipeline(
        device,
        format,
        createShaderModule,
      );
      if (!pipelineResult.ok) {
        publish(fail('module-and-pipeline', backendKind, pipelineCreated, pipelineFormats, pipelineResult.error));
        return;
      }
      pipelineCreated = true;
      pipelineFormats.push(format);
    }

    // A real mipmap blit for each prewarmed format forces deferred pipeline
    // validation while reusing the canonical cache layout, sampler and
    // bind-group contract.
    for (const format of formats) {
      const targetResult = device.createTexture({
        label: `mipmap-pipeline-probe-target-${format}`,
        size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        mipLevelCount: 2,
        format,
        usage: TEXTURE_BINDING_AND_COPY_DST,
      });
      if (!targetResult.ok) {
        publish(fail('render-submit', backendKind, pipelineCreated, pipelineFormats, targetResult.error));
        return;
      }
      const mipmapResult = blitMipmapsSync(
        device,
        targetResult.value,
        { format, width: 4, height: 4, levels: 2 },
      );
      if (!mipmapResult.ok) {
        publish(fail('render-submit', backendKind, pipelineCreated, pipelineFormats, mipmapResult.error));
        return;
      }
    }
    publish({
      schema: 'forgeax.mipmap-pipeline-probe/1',
      status: 'pass',
      stage: 'complete',
      backendKind,
      pipelineCreated,
      pipelineFormats,
    });
  } catch (error) {
    publish(fail(pipelineCreated ? 'render-submit' : 'setup', backendKind, pipelineCreated, pipelineFormats, error));
  }
}
