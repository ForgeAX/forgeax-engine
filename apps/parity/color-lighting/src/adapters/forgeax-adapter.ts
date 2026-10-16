import type {
  SceneCase,
  VertexColorBackend,
  VertexColorCaptureOutput,
  VertexColorProducerIdentity,
  VertexColorSemanticFixture,
} from '../contracts/types';
import type { RhiCanvasSurfacePresentationProof } from '@forgeax/engine-rhi';
import type { RenderInspection } from '@forgeax/engine-render';
import { VERTEX_COLOR_REQUIRED_CASES } from '../coverage/required-cases';
import { createNamedCaptures, type CaptureConfig, type CaptureEnvelope } from '../capture/named-capture';
import type { CaptureValidationResult } from '../capture/named-capture';
import type { AttachmentEvidence } from '../capture/attachment-readback';

export interface ForgeaxCaptureOutput {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly config: CaptureConfig;
  readonly observations?: AttachmentEvidence;
  readonly surfaceEvidence?: ForgeaxSurfaceEvidence;
}

export interface ForgeaxSurfaceEvidence {
  readonly captureIdentity: string;
  readonly actualBackendKind: RenderInspection['capabilities']['backendKind'];
  readonly surface: {
    readonly storageFormat: string;
    readonly displayFormat: string;
    readonly intermediateFormat?: string;
    readonly displayEncoded: boolean;
    readonly endpoint: 'surface.storage.raw';
    readonly capability: string;
  };
  readonly presentationProof?: RhiCanvasSurfacePresentationProof;
  readonly pixelReadbackEvidence: {
    readonly surfaceIdentity?: string;
    readonly observationId: string;
    readonly frameId: number;
    readonly width: number;
    readonly height: number;
    readonly byteLength: number;
    readonly rawHash: string;
    readonly status: 'present' | 'empty';
    readonly source: {
      readonly endpoint: 'surface.display.final';
      readonly method: 'webkit-compositor-rgba8' | 'chromium-compositor-rgba8';
    };
  };
}

export interface ExtendedLightingConsumerReceipt {
  readonly topology: 'extendedLighting';
  readonly generation: number;
  readonly identity: string;
  readonly candidate: string | undefined;
  readonly accepted: string | undefined;
  readonly lastKnownGood: string | undefined;
  readonly failure: string | undefined;
  readonly resourceCount: number;
  readonly uploadBytes: number;
  readonly recordReceipt: {
    readonly status: 'not-run' | 'ready' | 'recovered';
    readonly byteLength: 160;
  };
  readonly resourceReceipt: {
    readonly status: 'not-run' | 'candidate' | 'accepted' | 'lkg' | 'recovered';
    readonly resourceCount: number;
    readonly uploadBytes: number;
  };
}

export function projectExtendedLightingConsumerReceipt(
  inspection: RenderInspection,
): ExtendedLightingConsumerReceipt {
  return {
    topology: 'extendedLighting',
    generation: inspection.extendedLighting.generation,
    identity: `extendedLighting:generation-${inspection.extendedLighting.generation}`,
    candidate: inspection.extendedLighting.candidate,
    accepted: inspection.extendedLighting.accepted,
    lastKnownGood: inspection.extendedLighting.lastKnownGood,
    failure: inspection.extendedLighting.failure,
    resourceCount: inspection.extendedLighting.resourceCount,
    uploadBytes: inspection.extendedLighting.uploadBytes,
    recordReceipt: { status: 'not-run', byteLength: 160 },
    resourceReceipt: {
      status:
        inspection.extendedLighting.accepted !== undefined
          ? 'accepted'
          : inspection.extendedLighting.lastKnownGood !== undefined
            ? 'lkg'
            : inspection.extendedLighting.candidate !== undefined
              ? 'candidate'
              : 'not-run',
      resourceCount: inspection.extendedLighting.resourceCount,
      uploadBytes: inspection.extendedLighting.uploadBytes,
    },
  };
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle !== undefined) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function projectForgeaxSurfaceEvidence({
  inspection,
  backendId,
  caseId,
  pixels,
  width,
  height,
}: {
  readonly inspection: RenderInspection;
  readonly backendId: 'webkit-webgl2' | 'chromium-webgl2';
  readonly caseId: string;
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
}): Promise<ForgeaxSurfaceEvidence> {
  const expectedByteLength = width * height * 4;
  const rawHash = await hashBytes(pixels);
  const proofIdentity = inspection.output.presentationProof?.surfaceIdentity ?? 'missing';
  const observationId = inspection.observation.observationId;
  const frameId = inspection.observation.frameId;
  // This identity is derived entirely from the concrete case, surface proof,
  // frame observation, and readback bytes. It remains unique across isolated
  // browser pages without relying on process-local mutable counters.
  const captureIdentity = [
    backendId,
    caseId,
    proofIdentity,
    observationId,
    frameId,
    rawHash,
  ].join(':');
  return {
    captureIdentity,
    actualBackendKind: inspection.capabilities.backendKind,
    surface: {
      storageFormat: inspection.output.surfaceStorage,
      displayFormat: inspection.output.surfaceDisplay,
      ...(inspection.output.intermediateFormat === undefined ? {} : { intermediateFormat: inspection.output.intermediateFormat }),
      displayEncoded: inspection.output.displayEncoded,
      endpoint: inspection.output.endpoint,
      capability: inspection.output.capability,
    },
    ...(inspection.output.presentationProof === undefined ? {} : { presentationProof: inspection.output.presentationProof }),
    pixelReadbackEvidence: {
      surfaceIdentity: captureIdentity,
      observationId,
      frameId,
      width,
      height,
      byteLength: pixels.byteLength,
      rawHash,
      status: pixels.byteLength === expectedByteLength ? 'present' : 'empty',
      source: {
        endpoint: 'surface.display.final',
        method: backendId === 'webkit-webgl2' ? 'webkit-compositor-rgba8' : 'chromium-compositor-rgba8',
      },
    },
  };
}

export interface ForgeaxAdapter {
  readonly id: 'forgeax-webgpu' | 'forgeax-wgpu-webgl2';
  capture(sceneCase: SceneCase): Promise<CaptureValidationResult<CaptureEnvelope>>;
}

export interface VertexColorForgeaxProducer {
  readonly identity: VertexColorProducerIdentity;
  capture(fixture: VertexColorSemanticFixture, backend: VertexColorBackend): Promise<VertexColorCaptureOutput>;
}

export function createVertexColorForgeaxProducer(
  run: (fixture: VertexColorSemanticFixture, backend: VertexColorBackend) => Promise<VertexColorCaptureOutput>,
  sourceSha = 'workspace-source',
): VertexColorForgeaxProducer {
  const identity: VertexColorProducerIdentity = {
    implementation: 'forgeax',
    version: 'workspace',
    renderer: 'webgpu',
    adapterId: 'forgeax-vertex-color-webgpu',
    pinnedCommit: sourceSha,
    buildIdentity: 'forgeax-browser-and-dawn-vertex-color',
  };
  return {
    identity,
    async capture(fixture, backend) {
      const output = await run(fixture, backend);
      if (output.backend !== backend) throw new Error('ForgeaX vertex-color backend provenance mismatch');
      if (output.frameCount !== 60) throw new Error('ForgeaX vertex-color capture requires 60 frames');
      if (output.sourceSha !== sourceSha) throw new Error('ForgeaX vertex-color source SHA mismatch');
      const expectedHash = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === fixture.caseId)?.sourceFixtureHash;
      if (expectedHash === undefined || output.sourceFixtureHash !== expectedHash) throw new Error('ForgeaX vertex-color fixture hash mismatch');
      if (output.colorDomain !== fixture.colorDomain) throw new Error('ForgeaX vertex-color domain mismatch');
      validateVertexColorSamples(fixture, output);
      return output;
    },
  };
}

function validateVertexColorSamples(fixture: VertexColorSemanticFixture, output: VertexColorCaptureOutput): void {
  if (output.final.length === 0 || output.linear.length === 0 || output.readback !== 'copyTextureToBuffer') {
    throw new Error('vertex-color producer readback is incomplete');
  }
  const expectedIds = new Set(fixture.samplePoints.map((sample) => sample.id));
  if (output.samples.length !== expectedIds.size || output.samples.some((sample) => !expectedIds.has(sample.id))) {
    throw new Error('vertex-color producer samples do not match the semantic fixture');
  }
  if (output.samples.some((sample) => sample.rgba.some((channel) => !Number.isFinite(channel)))) {
    throw new Error('vertex-color producer sample is non-finite');
  }
}

export function createForgeaxAdapter(
  run: (sceneCase: SceneCase) => Promise<ForgeaxCaptureOutput>,
  renderer: 'webgpu' | 'webgl' = 'webgpu',
): ForgeaxAdapter {
  const id = renderer === 'webgpu' ? 'forgeax-webgpu' : 'forgeax-wgpu-webgl2';
  return {
    id,
    async capture(sceneCase) {
      const output = await run(sceneCase);
      const captures = await createNamedCaptures(output.linear, output.final);
      const pipeline = output.config.pipeline ?? sceneCase.pipeline?.identity;
      return {
        ok: true,
        value: {
          side: 'forgeax',
          role: 'primary',
          adapterId: id,
          provenance: { implementation: 'forgeax', version: 'workspace', renderer, adapterId: id },
          config: { ...output.config, ...(pipeline === undefined ? {} : { pipeline }) },
          captures,
          ...(output.config.readback === undefined ? {} : { readback: output.config.readback }),
          ...(output.observations === undefined ? {} : { observations: output.observations }),
          ...(output.surfaceEvidence === undefined ? {} : { surfaceEvidence: output.surfaceEvidence }),
        },
      };
    },
  };
}
