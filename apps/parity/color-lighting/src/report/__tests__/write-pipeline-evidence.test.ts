import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJsonBytes,
  createPipelineEvidenceArtifact,
  writePipelineEvidence,
} from '../write-pipeline-evidence';

const sceneCase = {
  caseId: 'direct-directional-urp',
  required: true,
  colorDomain: 'linearHdr',
  pipeline: { identity: 'standard', engineId: 'forgeax::standard', renderPath: 'forward' },
  scene: { width: 1, height: 1, background: [0, 0, 0, 1] },
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
} as const;

const normalization = {
  authorityId: 'threeR184SquaredWindow',
  intensityScale: 1,
  rangeModel: 'squared-finite',
  coneModel: 'radians-to-degrees',
} as const;

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function makeArtifact() {
  return createPipelineEvidenceArtifact({
    invocationId: 'm4-artifact-contract',
    sceneCase,
    pipelineId: 'forgeax::standard',
    runtimeId: 'browser',
    backendId: 'webgpu',
    frameId: 7,
    copySrc: true,
    lifetime: 'active',
    provenance: {
      implementation: 'forgeax',
      version: 'workspace',
      renderer: 'webgpu',
      adapterId: 'forgeax-webgpu',
    },
    normalization,
    linearHdr: {
      bytes: new Uint8Array([1, 2, 3, 4]),
      format: 'rgba16float',
      size: { width: 1, height: 1 },
    },
    finalDisplay: {
      bytes: new Uint8Array([5, 6, 7, 8]),
      format: 'rgba8unorm',
      size: { width: 1, height: 1 },
    },
  });
}

describe('PipelineEvidence artifact writer', () => {
  it('canonicalizes JSON and preserves byte/hash/provenance identity', async () => {
    const canonical = canonicalJsonBytes({ z: 1, a: [true, null] });
    expect(new TextDecoder().decode(canonical)).toBe('{"a":[true,null],"z":1}');

    const artifact = await makeArtifact();
    expect(artifact.invocationId).toBe('m4-artifact-contract');
    expect(artifact.pipelineId).toBe('forgeax::standard');
    expect(artifact.runtimeId).toBe('browser');
    expect(artifact.provenance.adapterId).toBe('forgeax-webgpu');
    expect(artifact.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.semanticHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.linearHdr.bytes).toEqual([1, 2, 3, 4]);
    expect(artifact.linearHdr.rawHash).toBe(sha256(new Uint8Array([1, 2, 3, 4])));
    expect(artifact.finalDisplay.rawHash).toBe(sha256(new Uint8Array([5, 6, 7, 8])));
  });

  it('writes explicit JSON bytes that the merge reader can consume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-pipeline-evidence-'));
    const path = join(directory, 'browser-urp.json');
    const artifact = await makeArtifact();
    await writePipelineEvidence(path, artifact);
    const parsed = JSON.parse(await readFile(path, 'utf8')) as typeof artifact;
    expect(parsed).toEqual(artifact);
    expect(parsed.linearHdr.bytes).toEqual([1, 2, 3, 4]);
    expect(parsed.finalDisplay.bytes).toEqual([5, 6, 7, 8]);
  });

  it.each([
    ['missing bytes', { linearHdr: { bytes: new Uint8Array(), format: 'rgba16float', size: { width: 1, height: 1 } } }],
    ['wrong pipeline runtime', { pipelineId: 'forgeax::standard', runtimeId: 'browser' }],
  ])('%s is rejected before artifact output', async (_name, override) => {
    await expect(createPipelineEvidenceArtifact({
      ...(await makeArtifact()),
      ...override,
    } as never)).rejects.toThrow();
  });
});
