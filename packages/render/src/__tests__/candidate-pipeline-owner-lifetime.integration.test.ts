import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { captureSceneSourceGuard } from '@forgeax/engine-scene/internal';
import { assert, expect, it } from 'vitest';
import { MeshFilter, MeshRenderer, Visibility, VisibilityStateValue } from '../components';
import { captureMeshPipelinePreparation } from '../publication/mesh-pipeline-preparation';
import type {
  CandidatePipelineInput,
  PreparedCandidatePipelines,
} from '../record/candidate-pipeline-preparation';
import { MaterialFrame } from '../scene/material-dispatch';
import { rendererInputHandoffFixture } from './renderer-input-handoff-fixture';
import { collectWeakOwners } from './weak-owner-collection-fixture';

async function fixture() {
  const f = await rendererInputHandoffFixture();
  const asset = createBoxGeometry(3, 1, 1).unwrap();
  const handle = f.assets.create(asset).unwrap();
  const entity = f.world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      { component: MeshRenderer, data: { preparePipelines: true } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  await f.draw();
  const scope = f.internals.sceneComposition?.entry?.source;
  assert(scope);
  const revision = scope.assetRevision(handle);
  assert(revision !== undefined);
  const mesh = f.internals.gpuStore.prepareMeshResidency(handle, asset, revision, scope).unwrap();
  const guard = captureSceneSourceGuard(
    f.world,
    [entity],
    [Transform, MeshFilter, MeshRenderer, Visibility],
  ).unwrap();
  const input: CandidatePipelineInput = {
    world: f.world,
    asset,
    mesh: mesh.entry,
    isCurrent: guard.isCurrent,
    preparation: captureMeshPipelinePreparation({
      world: f.world,
      entity,
      meshHandle: handle,
      mesh: asset,
      assets: f.assets,
      capabilities: f.internals.device.caps,
    }).unwrap(),
  };
  return {
    ...f,
    entity,
    input,
    close: async () => {
      guard.dispose();
      await mesh.lease.release(false);
      return f.close();
    },
  };
}

async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
  let result: Awaited<ReturnType<typeof f.manager.prepareCandidatePipelines>> | undefined;
  const controller = new AbortController();
  const pending = f.manager.prepareCandidatePipelines(f.input, controller.signal).then((value) => {
    result = value;
    return value;
  });
  for (let frame = 0; result === undefined && frame < 20; frame++) await f.draw();
  if (result === undefined) controller.abort();
  return (await pending).unwrap();
}

async function withFixture<T>(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<T>) {
  const f = await fixture(),
    failures: unknown[] = [];
  let value: { result: T } | undefined;
  try {
    value = { result: await run(f) };
  } catch (cause) {
    failures.push(cause);
  }
  try {
    const closed = await f.close();
    if (!closed.ok) failures.push(closed.error);
  } catch (cause) {
    failures.push(cause);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Candidate assertions and native owner cleanup failed');
  assert(value);
  return value.result;
}

async function closedOwner(retain: boolean) {
  return withFixture(async (f) => {
    const ticket = await prepare(f);
    expect(ticket.isCurrent()).toBe(true);
    const held = {
      ticket: retain ? ticket : undefined,
      owner: new WeakRef(f.manager.currentOwner),
      manager: new WeakRef(f.manager),
    };
    ticket.release();
    expect(ticket.isCurrent()).toBe(false);
    return held;
  });
}

it.each([
  true,
  false,
])('releases actual candidate owner callbacks after close, keep receipt=%s', async (retain) => {
  const held = await closedOwner(retain);
  await collectWeakOwners();
  expect(held.owner.deref()).toBeUndefined();
  expect(held.manager.deref()).toBeUndefined();
  expect(held.ticket?.isCurrent() ?? false).toBe(false);
  held.ticket?.release();
});

it('cancels pending preparation without a draw and leaves another actual request intact', () =>
  withFixture(async (f) => {
    const first = new AbortController(),
      second = new AbortController();
    const a = f.manager.prepareCandidatePipelines(f.input, first.signal);
    const b = f.manager.prepareCandidatePipelines(f.input, second.signal);
    first.abort();
    expect((await a).ok).toBe(false);
    const owner = f.manager.currentOwner.frameState.candidatePipelinePreparations;
    assert(owner);
    let references = 0;
    owner.materials.changesSince(new MaterialFrame(undefined), (_old, next) => {
      if (next !== undefined) references++;
    });
    expect(references).toBeGreaterThan(0);
    second.abort();
    expect((await b).ok).toBe(false);
    references = 0;
    owner.materials.changesSince(new MaterialFrame(undefined), (_old, next) => {
      if (next !== undefined) references++;
    });
    expect(references).toBe(0);
  }));

it('rejects release during a currentness callback after the callback returns true', () =>
  withFixture(async (f) => {
    const current = f.input.isCurrent;
    let release = false,
      ticket: PreparedCandidatePipelines | undefined;
    Object.assign(f.input, {
      isCurrent: () => {
        if (release) ticket?.release();
        return current();
      },
    });
    ticket = await prepare(f);
    expect(ticket.isCurrent()).toBe(true);
    release = true;
    expect(ticket.isCurrent()).toBe(false);
  }));

it('rejects an authored candidate edit after native preparation', () =>
  withFixture(async (f) => {
    const ticket = await prepare(f);
    f.world.set(f.entity, Transform, { pos: [3, 0, 0] }).unwrap();
    expect(ticket.isCurrent()).toBe(false);
  }));
