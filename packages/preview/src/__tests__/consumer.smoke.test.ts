import { Context } from '@forgeax/engine-plugin';
import {
  createCapabilityResolver,
  createToolRuntime as createRuntime,
  type ToolCapability,
} from '@forgeax/engine-tool-runtime';
import { describe, expect, it } from 'vitest';
import { createPreviewHost, previewHostCapability } from '../index.js';
import materialPreviewPlugin, { materialPreview } from '../material.js';
import { texturePreview } from '../texture.js';
import { vfxPreview } from '../vfx.js';

describe('native preview plugin consumer', () => {
  it('exposes one native contribution for each VFX and Texture subpath', () => {
    expect([vfxPreview.descriptor.id]).toEqual(['asset.vfx.preview']);
    expect([texturePreview.descriptor.id]).toEqual(['asset.texture.preview']);
  });

  it('activates a Fiber, leases previewHost, and returns structured subject failure', async () => {
    const ctx = new Context();
    const fiber = await ctx.plugin(materialPreviewPlugin);
    const host = createPreviewHost({
      runId: 'material.preview:smoke',
      snapshot: { revision: 1, digest: 'sha256:smoke' },
      projectRoot: '/fixture',
      backend: 'webgpu',
      signal: new AbortController().signal,
    });
    const contribution = materialPreview;
    if (contribution === undefined)
      throw new Error('material preview native plugin tool has no tool');
    const terminal = await createRuntime([contribution]).run(
      contribution,
      { guid: 'material-1' },
      {
        capabilityResolver: createCapabilityResolver(<T>(capability: ToolCapability<T>) =>
          capability.id === previewHostCapability.id ? (host as unknown as T) : undefined,
        ),
      },
    ).terminal;
    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'resource-preview-subject-invalid' } },
    });
    await fiber.dispose();
    await ctx.fiber.dispose();
  });

  it('fails closed when render observation or evidence is incomplete', async () => {
    const contribution = materialPreview;
    if (contribution === undefined)
      throw new Error('material preview native plugin tool has no tool');
    const material = {
      kind: 'material',
      digest: 'sha256:material',
      passes: [{ name: 'forward', program: { module: 'forgeax::material' } }],
      bindingsDigest: 'sha256:bindings',
      closureDigest: 'sha256:closure',
    };
    const artifacts = [
      { kind: 'rhi-tape' as const, digest: `sha256:${'1'.repeat(64)}` },
      { kind: 'png' as const, digest: `sha256:${'2'.repeat(64)}` },
      { kind: 'profile-capture' as const, digest: `sha256:${'3'.repeat(64)}` },
    ];
    const run = async (
      observation: Readonly<Record<string, string | number | boolean>>,
      evidence: typeof artifacts,
    ) => {
      const host = createPreviewHost({
        runId: 'material.preview:falsifier',
        snapshot: { revision: 1, digest: 'sha256:smoke' },
        projectRoot: '/fixture',
        backend: 'webgpu',
        signal: new AbortController().signal,
        subject: { guid: 'material-1', asset: material },
        renderer: {
          rendererReady: true,
          worldReady: true,
          drawCalls: 1,
          nonBlackPixels: 1,
          observation,
        },
        artifacts: evidence,
      });
      return createRuntime([contribution]).run(
        contribution,
        { guid: 'material-1' },
        {
          snapshot: { revision: 1, digest: 'sha256:smoke' },
          capabilityResolver: createCapabilityResolver(<T>(capability: ToolCapability<T>) =>
            capability.id === previewHostCapability.id ? (host as unknown as T) : undefined,
          ),
        },
      ).terminal;
    };
    const mismatched = await run(
      {
        subjectDigest: 'sha256:material',
        program: 'forgeax::wrong-material',
        pass: 'forward',
        bindingsDigest: 'sha256:bindings',
        closureDigest: 'sha256:closure',
      },
      artifacts,
    );
    expect(mismatched).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed', detail: { code: 'resource-preview-oracle-failed' } },
    });
    const emptyEvidence = await run(
      {
        subjectDigest: 'sha256:material',
        program: 'forgeax::material',
        pass: 'forward',
        bindingsDigest: 'sha256:bindings',
        closureDigest: 'sha256:closure',
      },
      [],
    );
    expect(emptyEvidence).toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-artifact-incomplete' },
    });
  });
});
