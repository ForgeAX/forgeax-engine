import { projectIblRawEvidence, projectIblCapabilityStatus, type IblRawEvidence } from '../report/capability-status';
import type { IblAuxiliaryProducer } from '../report/auxiliary-case-report';

export interface IblGpuCaseResult {
  readonly capability: ReturnType<typeof projectIblCapabilityStatus>;
  readonly evidence: IblRawEvidence;
  readonly finalDisplay: {
    readonly status: IblRawEvidence['status'];
    readonly bytes: Uint8Array | null;
    readonly format: 'rgba8unorm' | null;
    readonly rawHash: string | null;
  };
  readonly analytic: {
    readonly environment: number;
    readonly payload: number;
    readonly reconstructed: number;
    readonly maxError: number;
  };
}

export function serializeIblGpuCaseResult(result: IblGpuCaseResult): IblAuxiliaryProducer {
  return {
    capability: result.capability,
    evidence: {
      ...result.evidence,
      bytes: result.evidence.bytes === null ? null : Array.from(result.evidence.bytes),
    },
    finalDisplay: {
      ...result.finalDisplay,
      bytes: result.finalDisplay.bytes === null ? null : Array.from(result.finalDisplay.bytes),
    },
    analytic: result.analytic,
  };
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function analyticResult(): IblGpuCaseResult['analytic'] {
  const environment = 0.72;
  const payload = environment * Math.PI;
  const reconstructed = payload / Math.PI;
  return {
    environment,
    payload,
    reconstructed,
    maxError: Math.abs(reconstructed - environment),
  };
}

function failedResult(rgba16floatRenderable: boolean, analytic: IblGpuCaseResult['analytic']): IblGpuCaseResult {
  const capability = projectIblCapabilityStatus({ rgba16floatRenderable });
  const evidence = projectIblRawEvidence({
    attachmentName: 'ibl.constant-environment',
    layer: 0,
    capabilitySnapshot: { rgba16floatRenderable },
    fallbackArtifact: capability.fallbackArtifact,
    lastKnownGood: 'ibl.constant-environment@rgba16float',
    readback: { status: 'failed' },
  });
  return {
    capability,
    evidence,
    finalDisplay: { status: evidence.status, bytes: null, format: null, rawHash: null },
    analytic,
  };
}

async function readTextureBytes(device: GPUDevice, texture: GPUTexture, bytesPerTexel: number): Promise<Uint8Array> {
  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture },
    { buffer, bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buffer.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(buffer.getMappedRange().slice(0, bytesPerTexel));
  buffer.unmap();
  buffer.destroy();
  return bytes;
}

export async function captureIblGpuCase(gpu: GPU | undefined): Promise<IblGpuCaseResult> {
  const analytic = analyticResult();
  if (gpu === undefined) return failedResult(false, analytic);
  const adapter = await gpu.requestAdapter();
  if (adapter === null) return failedResult(false, analytic);
  const device = await adapter.requestDevice();
  let texture: GPUTexture | undefined;
  let finalTexture: GPUTexture | undefined;
  let rgba16floatRenderable = false;
  try {
    texture = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    device.pushErrorScope('validation');
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: texture.createView(),
        clearValue: { r: analytic.environment, g: analytic.environment, b: analytic.environment, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.end();
    device.queue.submit([encoder.finish()]);
    const validationError = await device.popErrorScope();
    rgba16floatRenderable = validationError === null;
    if (!rgba16floatRenderable) return failedResult(false, analytic);
    const bytes = await readTextureBytes(device, texture, 8);
    finalTexture = device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const finalEncoder = device.createCommandEncoder();
    const finalPass = finalEncoder.beginRenderPass({
      colorAttachments: [{
        view: finalTexture.createView(),
        clearValue: { r: analytic.environment, g: analytic.environment, b: analytic.environment, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    finalPass.end();
    device.queue.submit([finalEncoder.finish()]);
    const finalBytes = await readTextureBytes(device, finalTexture, 4);
    const evidence = projectIblRawEvidence({
      attachmentName: 'ibl.constant-environment',
      layer: 0,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.constant-environment@rgba16float',
      readback: {
        status: 'ready',
        bytes,
        format: 'rgba16float',
        size: { width: 1, height: 1 },
        rawHash: hashBytes(bytes),
        frameId: 0,
        lifetime: { frameId: 0, state: 'active' },
      },
    });
    return {
      capability: projectIblCapabilityStatus({ rgba16floatRenderable: true }),
      evidence,
      finalDisplay: {
        status: evidence.status,
        bytes: finalBytes,
        format: 'rgba8unorm',
        rawHash: hashBytes(finalBytes),
      },
      analytic,
    };
  } catch {
    return failedResult(false, analytic);
  } finally {
    texture?.destroy();
    finalTexture?.destroy();
    device.destroy();
  }
}
