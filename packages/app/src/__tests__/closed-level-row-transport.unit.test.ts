import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { encodeClosedLevelRows, RenderPublicationReceiver } from '@forgeax/engine-render/internal';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok, type ResultOk } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type {
  ClosedLevelFrameSelectionReceipt,
  ClosedLevelRowIdentity,
  ClosedLevelRowOperation,
  ClosedLevelRowReceipt,
} from '../execution/closed-level-row-protocol';
import { RenderClosedLevelRows } from '../execution/render-closed-level-rows';
import { RenderLevelFrameSelection } from '../execution/render-level-frame-selection';
import { SourceClosedLevelRows } from '../execution/source-closed-level-rows';
import { closedLevelWorld } from './fixtures/closed-level-world';

const publication = { source: 'streamed-level', epoch: 3 };
const level = { instance: 1, generation: 2, request: 4, attempt: 2 };

describe('closed Level row custody', () => {
  it('returns the exact completed frame only after matching the published selection receipt', async () => {
    const f = closedLevelWorld();
    const source = new SourceClosedLevelRows(() => ({
      publication,
      worldIdentity: f.world.identity,
      isCurrent: () => true,
      post({ id, serial }) {
        source.receive({ kind: 'closed-level-rows-result', id, serial, result: { ok: true } });
      },
    }));
    try {
      const sealed = (await source.stage(level, f.rows, { assets: f.coldAssets })).unwrap();
      let settled = false;
      const active = sealed.select(true).then((frame) => {
        settled = true;
        return frame;
      });
      expect(source.takeSelection(8, 17)).toEqual({ id: sealed.id, active: true });
      const accepted: ClosedLevelFrameSelectionReceipt = {
        kind: 'closed-level-selection-result',
        id: sealed.id,
        active: true,
        frameId: 8,
        revision: 17,
        result: { ok: true },
      };
      source.receiveSelection({ ...accepted, revision: 18 });
      source.receiveSelection({ ...accepted, active: false });
      await Promise.resolve();
      expect(settled).toBe(false);
      source.receiveSelection(accepted);
      await expect(active).resolves.toEqual({ active: true, frameId: 8, revision: 17 });
    } finally {
      source.invalidate();
      f.assets.dispose();
    }
  });

  it('reverts a pending draw, waits for preparation, and accepts only the new completed selection', async () => {
    const f = closedLevelWorld();
    const source = new SourceClosedLevelRows(() => ({
      publication,
      worldIdentity: f.world.identity,
      isCurrent: () => true,
      post({ id, serial }) {
        source.receive({ kind: 'closed-level-rows-result', id, serial, result: { ok: true } });
      },
    }));
    try {
      const sealed = (await source.stage(level, f.rows, { assets: f.coldAssets })).unwrap();
      const active = sealed.select(true).then(
        (accepted) => ({ accepted }),
        (error: unknown) => ({ error }),
      );
      const selection = source.takeSelection(8, 17);
      expect(selection).toEqual({ id: sealed.id, active: true });
      if (selection === undefined) throw Error('missing selection');
      const receipt: ClosedLevelFrameSelectionReceipt = {
        kind: 'closed-level-selection-result',
        id: sealed.id,
        active: true,
        frameId: 8,
        revision: 17,
        result: { ok: true },
      };
      const undo = vi.fn();
      const report = vi.fn((result: ClosedLevelFrameSelectionReceipt) =>
        source.receiveSelection(result),
      );
      const workerSelection = new RenderLevelFrameSelection(
        {
          worldIdentity: f.world.identity,
          frameId: 8,
          publication: { ...publication, revision: 17, record: new ArrayBuffer(0) },
        },
        selection,
        { select: () => ok(undo) },
        report,
      );
      let finishPreparation!: (result: ResultOk<void>) => void;
      const preparationCompleted = new Promise<ResultOk<void>>((resolve) => {
        finishPreparation = resolve;
      });
      workerSelection.apply({ ...publication, revision: 17 });
      workerSelection.finish({
        frameId: 8,
        deviceGeneration: 1,
        presentation: 'pending',
        presentationPendingReason: { code: 'material-pipeline-preparation', pass: 'forward' },
        completed: Promise.resolve(ok(undefined)),
        preparationCompleted,
      });
      expect(undo).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(report).not.toHaveBeenCalled();
      expect(source.takeSelection(9, 18)).toBeUndefined();
      finishPreparation(ok(undefined));
      await preparationCompleted;
      expect(report).toHaveBeenCalledWith({
        ...receipt,
        result: {
          ok: false,
          reason: 'pending',
          detail: { code: 'material-pipeline-preparation', pass: 'forward' },
        },
      });
      source.receiveSelection(receipt);
      expect(source.takeSelection(9, 18)).toEqual({ id: sealed.id, active: true });
      source.receiveSelection({ ...receipt, frameId: 9, revision: 18 });
      await expect(active).resolves.toEqual({
        accepted: { active: true, frameId: 9, revision: 18 },
      });
    } finally {
      source.invalidate();
      f.assets.dispose();
    }
  });

  it('seals exact complete chunks and cannot revive a retired stream', () => {
    const f = closedLevelWorld();
    const publicationReceiver = new RenderPublicationReceiver(publication);
    const receiver = new RenderClosedLevelRows(publication, f.world.identity, (asset) => {
      const result = publicationReceiver.retainClosedLevelAsset(publication, asset);
      return result.ok ? result.value : undefined;
    });
    const id = { publication, worldIdentity: f.world.identity, stream: 1, level };
    let serial = 0;
    const send = (operation: ClosedLevelRowOperation, target: ClosedLevelRowIdentity = id) =>
      receiver.receive({ kind: 'closed-level-rows', id: target, serial: ++serial, operation })
        .result;
    try {
      const [first, second] = [...encodeClosedLevelRows(f.rows, 1)];
      if (first === undefined || second === undefined) throw Error('missing fixture rows');
      expect(send({ kind: 'stage', ordinal: 1, rows: second })).toEqual({
        ok: false,
        reason: 'sequence',
      });
      expect(send({ kind: 'stage', ordinal: 0, rows: first })).toEqual({ ok: true });
      expect(receiver.borrowSealed(id)).toBeUndefined();
      expect(send({ kind: 'stage', ordinal: 0, rows: structuredClone(first) })).toEqual({
        ok: true,
      });
      const changed = structuredClone(first);
      changed.transforms[12] = 20;
      expect(send({ kind: 'stage', ordinal: 0, rows: changed })).toEqual({
        ok: false,
        reason: 'conflict',
      });
      expect(send({ kind: 'stage', ordinal: 1, rows: first })).toEqual({
        ok: false,
        reason: 'conflict',
      });
      expect(send({ kind: 'seal', assets: 0, chunks: 2, rows: 2 })).toEqual({
        ok: false,
        reason: 'sequence',
      });
      expect(
        send(
          { kind: 'stage', ordinal: 1, rows: second },
          { ...id, level: { ...level, attempt: 3 } },
        ),
      ).toEqual({ ok: false, reason: 'identity' });
      expect(send({ kind: 'stage', ordinal: 1, rows: second })).toEqual({ ok: true });
      expect(send({ kind: 'seal', assets: 0, chunks: 2, rows: 2 })).toEqual({
        ok: false,
        reason: 'assets',
      });
      const asset = structuredClone(f.coldAsset);
      expect(send({ kind: 'asset', ordinal: 0, asset })).toEqual({ ok: true });
      expect(send({ kind: 'asset', ordinal: 0, asset: structuredClone(asset) })).toEqual({
        ok: true,
      });
      for (const [ordinal, row] of f.coldAssets.entries()) {
        if (row.handle === f.texture) {
          expect(send({ kind: 'seal', assets: ordinal, chunks: 2, rows: 2 })).toEqual({
            ok: false,
            reason: 'assets',
          });
        }
        expect(send({ kind: 'asset', ordinal, asset: structuredClone(row) })).toEqual({ ok: true });
      }
      const seal = { kind: 'seal', assets: f.coldAssets.length, chunks: 2, rows: 2 } as const;
      expect(send(seal)).toEqual({ ok: true });
      expect(send(seal)).toEqual({ ok: true });
      const sealed = receiver.borrowSealed(id);
      expect(sealed?.chunks[0]?.[0]?.material.snapshot.materialHandle).toBe(f.material);
      expect(sealed?.assets.get(f.texture)?.hold.value.kind).toBe('texture');
      expect(sealed?.chunks.flat().map((row) => [row.entityKey, row.transform.world[12]])).toEqual([
        [f.members[0], -2],
        [f.members[1], 3],
      ]);
      expect(sealed?.rowsCurrent()).toBe(true);
      sealed?.assets.get(f.texture)?.hold.release();
      expect(sealed?.rowsCurrent()).toBe(true);
      expect(sealed?.isCurrent()).toBe(false);
      expect(send({ kind: 'retire' })).toEqual({ ok: true });
      expect(send({ kind: 'retire' })).toEqual({ ok: true });
      expect(sealed?.rowsCurrent()).toBe(false);
      expect(sealed?.isCurrent()).toBe(false);
      expect(send({ kind: 'stage', ordinal: 0, rows: first })).toEqual({
        ok: false,
        reason: 'closed',
      });
      expect(send({ kind: 'seal', assets: 0, chunks: 0, rows: 0 }, { ...id, stream: 2 })).toEqual({
        ok: true,
      });
    } finally {
      receiver.dispose();
      publicationReceiver.dispose();
      f.assets.dispose();
    }
  });

  it('releases the original attempt on cancellation, ignoring its delayed receipt', async () => {
    const f = closedLevelWorld();
    const publicationReceiver = new RenderPublicationReceiver(publication);
    const receiver = new RenderClosedLevelRows(publication, f.world.identity, (asset) => {
      const result = publicationReceiver.retainClosedLevelAsset(publication, asset);
      return result.ok ? result.value : undefined;
    });
    const abort = new AbortController();
    let held: ClosedLevelRowReceipt | undefined;
    const source = new SourceClosedLevelRows(() => ({
      publication,
      worldIdentity: f.world.identity,
      isCurrent: () => true,
      post(message, transfer) {
        const received = receiver.receive(structuredClone(message, { transfer }));
        if (message.operation.kind === 'stage' && held === undefined) held = received;
        else source.receive(received);
      },
    }));
    try {
      const pending = source.stage(level, f.rows, { signal: abort.signal, assets: f.coldAssets });
      await expect.poll(() => held?.result.ok).toBe(true);
      abort.abort();
      expect((await pending).ok).toBe(false);
      if (held === undefined) throw Error('expected a held stage receipt');
      source.receive(held);
      expect(receiver.borrowSealed(held.id)).toBeUndefined();
      const next = (
        await source.stage({ ...level, attempt: 3 }, f.rows, { assets: f.coldAssets })
      ).unwrap();
      expect(receiver.borrowSealed(next.id)?.isCurrent()).toBe(true);
      expect(receiver.borrowSealed(next.id)?.assets.get(f.coldMesh)?.version).toBe(
        f.coldAsset.revision,
      );
      expect(f.coldAsset.value.vertices.byteLength).toBeGreaterThan(0);
      await next.retire();
      expect(receiver.borrowSealed(next.id)).toBeUndefined();
    } finally {
      source.invalidate();
      receiver.dispose();
      publicationReceiver.dispose();
      f.assets.dispose();
    }
  });

  it('admits a cold producer program before acknowledging a Level seal', async () => {
    const f = closedLevelWorld();
    const shader = 'pine-basin::cooked-shadow';
    const wgsl = '@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }';
    f.assets.shaderRegistry.installMaterialArtifact(shader, { source: wgsl, paramSchema: [] });
    for (const { material } of f.rows.renderables)
      material.adoptProgramSnapshot(
        {
          ...material.snapshot,
          materialSceneIndexProgramKeys: {
            shadow: { pass: 'shadow', specializationKey: shader },
          },
        },
        true,
      );
    const publicationReceiver = new RenderPublicationReceiver(publication);
    const receivingAssets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const install = vi.fn(
      (programs: NonNullable<Extract<ClosedLevelRowOperation, { kind: 'seal' }>['programs']>) => {
        for (const { key, shader } of programs)
          if ('source' in shader)
            receivingAssets.shaderRegistry.installMaterialArtifact(key, shader);
      },
    );
    const receiver = new RenderClosedLevelRows(
      publication,
      f.world.identity,
      (asset) => {
        const retained = publicationReceiver.retainClosedLevelAsset(publication, asset);
        return retained.ok ? retained.value : undefined;
      },
      install,
    );
    const source = new SourceClosedLevelRows(
      () => ({
        publication,
        worldIdentity: f.world.identity,
        isCurrent: () => true,
        post(message, transfer) {
          source.receive(receiver.receive(structuredClone(message, { transfer })));
        },
      }),
      () => f.assets,
    );
    try {
      expect(receivingAssets.shaderRegistry.findMaterialArtifact(shader).ok).toBe(false);
      install.mockImplementationOnce(() => {
        throw Error('invalid program');
      });
      expect((await source.stage(level, f.rows, { assets: f.coldAssets })).ok).toBe(false);
      const next = (
        await source.stage({ ...level, attempt: 3 }, f.rows, { assets: f.coldAssets })
      ).unwrap();
      expect(receiver.borrowSealed(next.id)?.isCurrent()).toBe(true);
      expect(receivingAssets.shaderRegistry.findMaterialArtifact(shader).unwrap().source).toBe(
        wgsl,
      );
      (await source.stage({ ...level, attempt: 4 }, f.rows, { assets: f.coldAssets })).unwrap();
      expect(install).toHaveBeenCalledTimes(2);
    } finally {
      source.invalidate();
      receiver.dispose();
      publicationReceiver.dispose();
      receivingAssets.dispose();
      f.assets.dispose();
    }
  });

  it('shares exact asset custody across sealed Levels and retries a missing retained version', async () => {
    const f = closedLevelWorld();
    const publicationReceiver = new RenderPublicationReceiver(publication);
    const receiver = new RenderClosedLevelRows(publication, f.world.identity, (asset) => {
      const result = publicationReceiver.retainClosedLevelAsset(publication, asset);
      return result.ok ? result.value : undefined;
    });
    const assetPayloads: number[] = [];
    const source = new SourceClosedLevelRows(() => ({
      publication,
      worldIdentity: f.world.identity,
      isCurrent: () => true,
      post(message, transfer) {
        if (message.operation.kind === 'asset' && 'value' in message.operation.asset)
          assetPayloads.push(message.operation.asset.handle);
        source.receive(receiver.receive(structuredClone(message, { transfer })));
      },
    }));
    const stage = async (attempt: number) =>
      (await source.stage({ ...level, attempt }, f.rows, { assets: f.coldAssets })).unwrap();
    try {
      const first = await stage(1);
      expect(assetPayloads).toEqual(f.coldAssets.map((asset) => asset.handle));
      assetPayloads.length = 0;
      const second = await stage(2);
      expect(assetPayloads).toEqual([]);
      await first.retire();
      const held = receiver.borrowSealed(second.id);
      expect(held?.isCurrent()).toBe(true);
      held?.assets.get(f.texture)?.hold.release();
      expect(held?.isCurrent()).toBe(false);
      const third = await stage(3);
      expect(assetPayloads).toEqual([f.texture]);
      await second.retire();
      expect(receiver.borrowSealed(third.id)?.isCurrent()).toBe(true);
      await third.retire();
      assetPayloads.length = 0;
      const coldAgain = await stage(4);
      expect(assetPayloads).toEqual(f.coldAssets.map((asset) => asset.handle));
      await coldAgain.retire();
    } finally {
      source.invalidate();
      receiver.dispose();
      publicationReceiver.dispose();
      f.assets.dispose();
    }
  });
});

it('rolls back the entire visual exchange before drawing when one recipient refuses', () => {
  const worldIdentity = 'fixture-world';
  const id = (stream: number): ClosedLevelRowIdentity => ({
    publication,
    worldIdentity,
    stream,
    level: { ...level, instance: stream },
  });
  const changes = [
    { id: id(1), active: true },
    { id: id(2), active: true },
    { id: id(3), active: false },
  ];
  const selected = new Set([3]);
  const replies = vi.fn();
  const transaction = new RenderLevelFrameSelection(
    {
      worldIdentity,
      frameId: 22,
      publication: { ...publication, revision: 23, record: new ArrayBuffer(0) },
    },
    { changes },
    {
      select({ id: identity, active }) {
        if (identity.stream === 2)
          return {
            ok: false,
            error: { ok: false, reason: 'view-obsolete' },
          };
        if (active) selected.add(identity.stream);
        else selected.delete(identity.stream);
        return ok(() => {
          selected.delete(identity.stream);
        });
      },
    },
    replies,
  );
  transaction.apply({ ...publication, revision: 23 });
  expect([...selected]).toEqual([3]);
  transaction.finish(undefined);
  for (const change of changes)
    expect(replies).toHaveBeenCalledWith({
      ...change,
      kind: 'closed-level-selection-result',
      frameId: 22,
      revision: 23,
      result: { ok: false, reason: 'view-obsolete' },
    });
});
