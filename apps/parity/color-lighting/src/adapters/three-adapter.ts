import type {
  SceneCase,
  VertexColorBackend,
  VertexColorCaptureOutput,
  VertexColorProducerIdentity,
  VertexColorSemanticFixture,
} from '../contracts/types';
import { VERTEX_COLOR_REQUIRED_CASES } from '../coverage/required-cases';
import { createNamedCaptures, type CaptureConfig, type CaptureEnvelope } from '../capture/named-capture';
import type { CaptureValidationResult } from '../capture/named-capture';
import type { ThreeR184ToneMode } from '../analytic/three-r184-tonemap';
export { THREE_R184_PROVENANCE, validateAutoExposureFixture } from '../contracts/auto-exposure-scene-case';

export interface ThreeCaptureOutput {
  readonly linear: readonly number[];
  readonly final: readonly number[];
  readonly config: CaptureConfig;
}

export interface ThreeAdapter {
  readonly id: 'three-r184-webgpu' | 'three-r184-webgl-fallback';
  capture(sceneCase: SceneCase): Promise<CaptureValidationResult<CaptureEnvelope>>;
}

export interface VertexColorThreeProducer {
  readonly identity: VertexColorProducerIdentity;
  capture(fixture: VertexColorSemanticFixture, backend: VertexColorBackend): Promise<VertexColorCaptureOutput>;
}

export function createVertexColorThreeProducer(
  run: (fixture: VertexColorSemanticFixture, backend: VertexColorBackend) => Promise<VertexColorCaptureOutput>,
  pinnedCommit = 'three-r184-pinned',
): VertexColorThreeProducer {
  const identity: VertexColorProducerIdentity = {
    implementation: 'three',
    version: 'r184',
    renderer: 'webgpu',
    adapterId: 'three-r184-vertex-color-webgpu',
    pinnedCommit,
    buildIdentity: 'three-webgpu-r184-vertex-color',
  };
  return {
    identity,
    async capture(fixture, backend) {
      const output = await run(fixture, backend);
      if (output.backend !== backend) throw new Error('Three r184 vertex-color backend provenance mismatch');
      if (output.frameCount !== 60) throw new Error('Three r184 vertex-color capture requires 60 frames');
      const expectedHash = VERTEX_COLOR_REQUIRED_CASES.find((entry) => entry.caseId === fixture.caseId)?.sourceFixtureHash;
      if (expectedHash === undefined || output.sourceFixtureHash !== expectedHash) throw new Error('Three r184 vertex-color fixture hash mismatch');
      if (output.colorDomain !== fixture.colorDomain) throw new Error('Three r184 vertex-color domain mismatch');
      validateVertexColorSamples(fixture, output);
      return output;
    },
  };
}

function validateVertexColorSamples(fixture: VertexColorSemanticFixture, output: VertexColorCaptureOutput): void {
  if (output.final.length === 0 || output.linear.length === 0 || output.readback !== 'readRenderTargetPixelsAsync') {
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

export function threeToneMappingId(mode: ThreeR184ToneMode): number {
  switch (mode) {
    case 'linear': return 1;
    case 'reinhard': return 2;
    case 'cineon': return 3;
    case 'aces-filmic': return 4;
    case 'agx': return 6;
    case 'neutral': return 7;
  }
}

export function createThreeAdapter(
  run: (sceneCase: SceneCase) => Promise<ThreeCaptureOutput>,
  renderer: 'webgpu' | 'webgl' = 'webgpu',
): ThreeAdapter {
  const id = renderer === 'webgpu' ? 'three-r184-webgpu' : 'three-r184-webgl-fallback';
  return {
    id,
    async capture(sceneCase) {
      const output = await run(sceneCase);
      const captures = await createNamedCaptures(output.linear, output.final);
      const pipeline = output.config.pipeline ?? sceneCase.pipeline?.identity;
      return {
        ok: true,
        value: {
          side: 'three',
          role: renderer === 'webgpu' ? 'primary' : 'fallback',
          adapterId: id,
          provenance: { implementation: 'three', version: 'r184', renderer, adapterId: id },
          config: { ...output.config, ...(pipeline === undefined ? {} : { pipeline }) },
          captures,
          ...(output.config.readback === undefined ? {} : { readback: output.config.readback }),
        },
      };
    },
  };
}
