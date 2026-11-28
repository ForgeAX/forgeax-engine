import { readFileSync } from 'node:fs';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { renderPublicationTransfers } from '@forgeax/engine-render';
import { rhi } from '@forgeax/engine-rhi-null';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { WATER_SYSTEM_RESOURCE, WaterSystem } from '@forgeax/engine-water';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  abortFeatureFrame,
  prepareFeatureFrame,
  submitFeatureFrame,
} from '../../../render/src/__tests__/feature-frame-driver';
import { withBuiltinRenderFeatures } from '../../../render/src/features/builtins';
import { createRenderFeatureHost } from '../../../render/src/features/host';
import { resolveStandardRenderFeatureTargets } from '../../../render/src/features/targets';
import type { RenderFeature } from '../../../render/src/features/types';
import { createRenderPublisher } from '../../../render/src/publication/publisher';
import { RenderPublicationReceiver } from '../../../render/src/publication/receiver';

function fixtureDrawSource(): string {
  const text = readFileSync(new URL('./multi-camera-vfx.fixture.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile(
    'multi-camera-vfx.fixture.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  let draw: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === 'draw' &&
      node.initializer !== undefined &&
      ts.isArrowFunction(node.initializer)
    )
      draw = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (draw === undefined) throw new Error('The original fixture draw adapter is required');
  return ts.transpileModule(`const draw = ${draw.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

describe('Multi-camera fixture publication acknowledgment', () => {
  it('batches real builtin and requested feedback once and preserves failed-submit retry admission', async () => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    // A source-owned Water system publishes its frame receipt; a World with
    // no Water source uses the canonical idle value and omits that wire row.
    world.insertResource(WATER_SYSTEM_RESOURCE, new WaterSystem(() => undefined));
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const sourceSubmitted = vi.fn();
    const feature: RenderFeature<null> = {
      identity: 'fixture-ack-control',
      extract: () => ok(null),
      plan: () =>
        ok({
          work: [{ scope: 'frame', resources: [], passes: [] }],
          sourceFeedback: 'original-feedback',
        }),
      onSourceFrameSubmitted: sourceSubmitted,
    };
    const roster = withBuiltinRenderFeatures([feature]);
    const identity = { source: 'fixture-ack', epoch: 1 };
    const publisher = createRenderPublisher(world, assets, identity, device.caps, roster);
    const receiver = new RenderPublicationReceiver(identity);
    const host = createRenderFeatureHost(roster).unwrap();
    const acknowledge = vi.spyOn(publisher, 'acknowledgeFeatures');
    let reject = false;
    const renderer = {
      inspect: () => ({ featureDiagnostics: [] }),
      draw(request: {
        publication: Parameters<typeof receiver.accept>[0];
        onFeatureSourceSubmitted: (identity: string, feedback: unknown) => void;
      }) {
        const accepted = receiver.accept(request.publication).unwrap();
        const targets = resolveStandardRenderFeatureTargets({
          tonemap: 'aces',
          antialias: 'none',
          storageBuffer: device.caps.storageBuffer,
          multisample: true,
          colorAttachmentFormat: 'rgba8unorm',
        });
        const batch = prepareFeatureFrame(
          host,
          ['left', 'right'].map((identity) => ({
            identity,
            render: true,
            world: undefined,
            publishedFeatures: accepted.packet.features,
            frameNumber: request.publication.revision,
            caps: device.caps,
            targets,
            frameSize: { width: 32, height: 32 },
            onFeatureSourceSubmitted: request.onFeatureSourceSubmitted,
          })),
        );
        expect(batch.frame.errors).toEqual([]);
        if (reject) {
          abortFeatureFrame(host);
          return { ok: false, error: { code: 'fixture-submit-rejected' } };
        }
        submitFeatureFrame(host);
        submitFeatureFrame(host);
        return ok({ completed: Promise.resolve(ok(undefined)) });
      },
    };
    const value = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
      if (!result.ok) throw result.error;
      return result.value;
    };
    const required = <T>(value: T | undefined): T => {
      if (value === undefined) throw new Error('Required fixture value');
      return value;
    };
    // Execute the actual fixture closure. The CPU control supplies its frame
    // transaction through the real Feature host and publisher, not GPU pixels.
    const adapter = new Function(
      'publisher',
      'renderer',
      'world',
      'propagateTransforms',
      'renderPublicationTransfers',
      'renderValue',
      'required',
      'lease',
      'errors',
      `let frameNumber = 0; let acknowledgements = 0; ${fixtureDrawSource()} return {draw, count:()=>acknowledgements};`,
    )(
      publisher,
      renderer,
      world,
      () => ok(undefined),
      renderPublicationTransfers,
      value,
      required,
      undefined,
      [],
    ) as { draw: (update: boolean, time: number) => Promise<unknown>; count: () => number };
    try {
      world.update(1 / 60).unwrap();
      await adapter.draw(false, 1 / 60);
      expect(adapter.count()).toBeLessThanOrEqual(1);
      expect(adapter.count()).toBe(1);
      expect(acknowledge).toHaveBeenCalledOnce();
      const [revision, receipts] = acknowledge.mock.calls[0] ?? [];
      expect(receipts?.map((row) => row.identity)).toEqual([
        'water-fluid-simulation',
        feature.identity,
      ]);
      expect(sourceSubmitted).toHaveBeenCalledOnce();
      if (revision === undefined || receipts === undefined)
        throw new Error('The original batch is required');
      expect(publisher.acknowledgeFeatures(revision, receipts).ok).toBe(false);
      acknowledge.mockClear();
      reject = true;
      await expect(adapter.draw(false, 1 / 60)).rejects.toThrow('fixture-submit-rejected');
      expect(adapter.count()).toBe(1);
      expect(acknowledge).not.toHaveBeenCalled();
      reject = false;
      await adapter.draw(false, 1 / 60);
      expect(adapter.count()).toBe(2);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(sourceSubmitted).toHaveBeenCalledTimes(2);
    } finally {
      abortFeatureFrame(host);
      host.dispose();
      receiver.dispose();
      publisher.dispose();
      assets.dispose();
    }
  });
});
