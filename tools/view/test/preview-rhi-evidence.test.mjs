import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { savePreviewRhiEvidence } from '../scripts/preview-rhi-evidence.mjs';
import { verifyInlinePreviews } from '../scripts/verify-inline-previews.mjs';

async function fixture(context, useEvidenceRoot = false) {
  const root = await mkdtemp(join(tmpdir(), 'preview-rhi-evidence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'game');
  const evidence = join(root, 'evidence');
  await mkdir(projectRoot);
  await mkdir(evidence);
  // Persistence tests opaque bytes; it does not substitute a synthetic tape for GPU proof.
  const bytes = Buffer.from([0, 255, 17, 0, 32]);
  const captureRoot = useEvidenceRoot ? evidence : projectRoot;
  const directory = join(captureRoot, '.forgeax-debug', 'native-preview-window');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'frame.rhitape');
  await writeFile(path, bytes);
  const target = { targetId: 'mesh-preview', worldId: 'world-5' };
  const observation = {
    targetId: target.targetId, worldIdentity: target.worldId, status: 'uploaded',
    seed: 'omitted', evidence: 'commands-and-bindings', mapping: 'complete',
    frames: [{ frameId: 3, worldIdentity: target.worldId, completion: 'pending' }],
    artifact: { kind: 'rhi-tape', path, bytes: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
  };
  return { projectRoot, evidence, captureRoot, target, observation, bytes };
}

// This exercises failure routing and file preservation, not browser/GPU acceptance.
function failedInlinePreview(input, failure) {
  const scene = { target: { targetId: 'scene', worldId: 'scene-world' } };
  const preview = { asset: { guid: 'mesh', kind: 'mesh' }, target: { ...input.target, generation: 7 } };
  const state = { project: { id: 'project' }, scenePreview: scene,
    assets: [preview.asset, { guid: 'material', kind: 'material' }], previews: [preview] };
  const query = { waitFor: async () => {}, count: async () => 1, locator: () => query };
  return {
    page: {
      locator: () => ({ ...query, count: async () => 0 }),
      getByTestId: () => query,
      waitForFunction: async () => ({ jsonValue: async () => [320, 240], dispose: async () => {} }),
    },
    workspace: {
      snapshot: () => state,
      openAsset: async () => state,
      getSceneTree: async () => ({ worldId: input.target.worldId, nodes: [{}] }),
      getCamera: async args => {
        assert.deepEqual(args, { targetId: input.target.targetId, targetGeneration: 7 });
        return { committed: true, interaction: null };
      },
      capture: async args => {
        assert.deepEqual(args, { targetId: input.target.targetId, targetGeneration: 7 });
        throw failure;
      },
    },
  };
}

test('the inline probe rejects an active mesh camera before requesting capture', async context => {
  const options = failedInlinePreview(await fixture(context), new Error('capture must not run'));
  options.workspace.getCamera = async () => ({ committed: false, interaction: { interactionId: 'initial-pivot' } });
  let captures = 0;
  options.workspace.capture = async () => { captures += 1; };
  await assert.rejects(verifyInlinePreviews(options), /mesh preview initialization must commit before capture/);
  assert.equal(captures, 0);
});

test('the inline preview capture failure preserves its exact native bytes and propagates the original error', async context => {
  const input = await fixture(context, true);
  const failure = new Error('original preview capture timeout');
  const options = failedInlinePreview(input, failure);
  await assert.rejects(verifyInlinePreviews({ ...options,
    onCaptureFailure: async ({ target, error }) => {
      assert.equal(error, failure);
      assert.deepEqual(target, { ...input.target, targetGeneration: 7 });
      const saved = await savePreviewRhiEvidence({ ...input, target });
      assert.equal(saved.status, 'saved');
    },
  }), error => error === failure);
  assert.deepEqual(await readFile(join(input.evidence, 'failure-preview.rhitape')), input.bytes);
});

test('an inline preview evidence failure keeps the original capture failure', async context => {
  const input = await fixture(context);
  const failure = new Error('original preview capture timeout');
  await assert.rejects(verifyInlinePreviews({ ...failedInlinePreview(input, failure),
    onCaptureFailure: async () => { throw new Error('diagnostic write unavailable'); },
  }), error => error === failure);
});

test('preserves the exact native ArtifactRef bytes and mapping before project disposal', async context => {
  const input = await fixture(context);
  const result = await savePreviewRhiEvidence(input);
  await rm(input.projectRoot, { recursive: true, force: true });
  assert.equal(result.status, 'saved');
  assert.deepEqual(await readFile(result.artifact.path), input.bytes);
  assert.deepEqual(result.observation.frames, input.observation.frames);
  assert.equal(result.artifact.digest, input.observation.artifact.digest);
  assert.equal(result.seed, 'omitted');
  assert.deepEqual(JSON.parse(await readFile(join(input.evidence, 'failure-preview-rhi.json'), 'utf8')), result);
});

for (const [field, value] of [['targetId', 'healthy-scene'], ['worldIdentity', 'world-other']]) {
  test(`rejects a ${field} mismatch instead of saving another live owner's tape`, async context => {
    const input = await fixture(context);
    input.observation[field] = value;
    const result = await savePreviewRhiEvidence(input);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'native-window-owner-mismatch');
    await assert.rejects(readFile(join(input.evidence, 'failure-preview.rhitape')), { code: 'ENOENT' });
  });
}

for (const field of ['digest', 'bytes']) {
  test(`retains an unavailable receipt when native artifact ${field} differs`, async context => {
    const input = await fixture(context);
    input.observation.artifact[field] = field === 'digest' ? 'sha256:wrong' : input.bytes.length + 1;
    const result = await savePreviewRhiEvidence(input);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'native-artifact-preservation-failed');
    await assert.rejects(readFile(join(input.evidence, 'failure-preview.rhitape')), { code: 'ENOENT' });
  });
}

test('keeps native capture failure progress without claiming an available frame', async context => {
  const input = await fixture(context);
  input.observation = { targetId: input.target.targetId, worldIdentity: input.target.worldId,
    status: 'capture-error', error: { code: 'capture-timeout', detail: { progress: 'queue-drain' } } };
  const result = await savePreviewRhiEvidence(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.observation.error, input.observation.error);
  assert.equal(result.reason, 'native-window-not-uploaded');
});

test('does not read a native artifact outside the configured recorder output', async context => {
  const input = await fixture(context);
  input.observation.artifact.path = join(input.evidence, 'foreign.rhitape');
  await writeFile(input.observation.artifact.path, input.bytes);
  const result = await savePreviewRhiEvidence(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'native-artifact-preservation-failed');
  assert.match(result.error.message, /outside the native capture output/);
});

test('records unavailable when the failed preview has no native recorder observation', async context => {
  const input = await fixture(context);
  input.observation = undefined;
  const result = await savePreviewRhiEvidence(input);
  assert.equal(result.reason, 'native-window-unavailable');
  assert.equal(result.status, 'unavailable');
});

test('does not substitute a healthy observation when failure precedes preview capture', async context => {
  const input = await fixture(context);
  input.target = undefined;
  const result = await savePreviewRhiEvidence(input);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-failed-preview-capture');
  await assert.rejects(readFile(join(input.evidence, 'failure-preview.rhitape')), { code: 'ENOENT' });
});

test('accepts the actual CI native upload root under FORGEAX_EVIDENCE_DIR', async context => {
  const input = await fixture(context, true);
  const result = await savePreviewRhiEvidence(input);
  assert.equal(result.status, 'saved');
  await rm(join(input.evidence, '.forgeax-debug'), { recursive: true, force: true });
  assert.deepEqual(await readFile(result.artifact.path), input.bytes);
});
