import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Time, World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import { recordFrameTransaction } from '../../assembly/frame-recording';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../../components';
import { renderPublicationTransfers } from '../../publication/contract';
import { createRenderPublisher } from '../../publication/publisher';
import { RenderPublicationReceiver } from '../../publication/receiver';
import { PersistentRenderScene } from '../../scene/render-scene';
import {
  currentDirectionalShadowPublication,
  prepareDirectionalCascadeCadence,
} from '../directional-cascade-cadence';
import { prepareDirectionalShadowCache } from '../directional-shadow-cache';
import type { RenderFrameState } from '../frame-snapshot';
import type { RenderSystemInternals } from '../render-context';

function fixture(staggerCascades = true) {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'directional-shadow-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
    )
    .unwrap();
  world
    .spawn({
      component: DirectionalLight,
      data: { staggerCascades, cascadeCount: 3, direction: [0.2, -1, 0.1] },
    })
    .unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(0).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  // Narrow record-stage inputs follow the existing terrain shadow-cache fixture.
  const epochs = { catalogEpoch: 1, meshResidencyEpoch: 1 };
  const mesh = { contentEpoch: 1 };
  const validated = [{ mesh }];
  const internals = {
    assets: {
      get catalogEpoch() {
        return epochs.catalogEpoch;
      },
    },
    gpuStore: {
      get meshResidencyEpoch() {
        return epochs.meshResidencyEpoch;
      },
    },
  } as unknown as RenderSystemInternals;
  const state = {
    compiledFrameGraph: { topologyKey: 'same-light-graph' },
    installedPipelineHandle: 9,
    directionalShadowCache: null,
  } as unknown as RenderFrameState;
  const receive = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    return accepted;
  };
  const publish = () => {
    const accepted = receive();
    scene.consumePublication(accepted);
    const returned = structuredClone(renderPublicationTransfers(accepted.packet), {
      transfer: renderPublicationTransfers(accepted.packet),
    });
    publisher.recycle(accepted.packet.revision, returned).unwrap();
    return accepted;
  };
  const decide = (accepted: ReturnType<typeof publish>) =>
    prepareDirectionalShadowCache(
      internals,
      state,
      [accepted.resources],
      [],
      accepted.frame.lights,
      1024,
      validated as never,
      scene.shadowCasterProjection(),
    );
  const dispose = () => {
    scene.dispose();
    publisher.dispose();
  };
  return {
    world,
    identity,
    entity,
    receiver,
    scene,
    state,
    epochs,
    mesh,
    validated,
    receive,
    publish,
    decide,
    dispose,
  };
}

function requiredSource(f: ReturnType<typeof fixture>) {
  const casters = f.scene.shadowCasterProjection();
  const source = casters?.content.publicationSource;
  if (casters === undefined || source === undefined) throw new Error('expected accepted source');
  return { casters, source };
}

describe('accepted publication CPU shadow authority', () => {
  it('keeps default publication recording uncached and never accepts a bare lease-less harness', () => {
    const f = fixture(false);
    try {
      const accepted = f.publish();
      expect(f.scene.shadowCasterProjection()?.content.publicationSource).toBeUndefined();
      expect(f.decide(accepted)).toEqual({ miss: 'uncached', next: null });
    } finally {
      f.dispose();
    }
    expect(currentDirectionalShadowPublication([], undefined, null)).toBeUndefined();
  });

  it('proves no-change publication content without treating every packet revision as content', () => {
    const f = fixture();
    try {
      const first = f.publish();
      expect(first.frame.lights.lightViewProj).toHaveLength(4);
      expect(
        first.frame.lights.lightViewProj?.every((matrix) => matrix.every(Number.isFinite)),
      ).toBe(true);
      expect(first.frame.lights.splitPlanes?.every(Number.isFinite)).toBe(true);
      const firstSource = requiredSource(f).source;
      const initial = f.decide(first);
      expect(initial.miss).toBe('first-publication');
      expect(initial.next?.worldStateTokens).toEqual([]);
      f.state.directionalShadowCache = initial.next;
      const accepted = f.publish();
      const next = requiredSource(f);
      expect(accepted.packet.revision).toBe(first.packet.revision + 1);
      expect(firstSource.isCurrent()).toBe(false);
      expect(next.source.isCurrent()).toBe(true);
      expect(f.decide(accepted).miss).toBeUndefined();
      expect(
        currentDirectionalShadowPublication(
          [first.resources],
          next.casters,
          f.state.directionalShadowCache,
        ),
      ).toBe(next.source);
    } finally {
      f.dispose();
    }
  });

  it('allows bounded moving-caster cadence only under current scene authority', () => {
    const f = fixture();
    try {
      const first = f.publish();
      const initial = f.decide(first);
      f.state.directionalShadowCache = initial.next;
      const cadence = prepareDirectionalCascadeCadence(first.frame.lights, undefined, initial.miss);
      if (cadence.next === null) throw new Error('expected submitted cadence');
      const before = requiredSource(f).casters.content;
      f.world.set(f.entity, Transform, { pos: [1, 0, 0] }).unwrap();
      f.world.update(1 / 60).unwrap();
      const moved = f.publish();
      const after = requiredSource(f).casters.content;
      expect(after.sceneRevision).not.toBe(before.sceneRevision);
      expect(after.dispatchRevision).toBe(before.dispatchRevision);
      const decision = f.decide(moved);
      expect(decision.miss).toBe('content-changed');
      expect(
        prepareDirectionalCascadeCadence(moved.frame.lights, cadence.next, decision.miss)
          .cascadeMiss,
      ).toEqual(['content-changed', 'content-changed', undefined]);
    } finally {
      f.dispose();
    }
  });

  it('rejects stale accepted input/current resources mismatch and retired composition', () => {
    const f = fixture();
    const other = fixture();
    try {
      const first = f.publish();
      const old = requiredSource(f);
      f.state.directionalShadowCache = f.decide(first).next;
      const different = other.publish();
      expect(
        currentDirectionalShadowPublication(
          [different.resources],
          old.casters,
          f.state.directionalShadowCache,
        ),
      ).toBeUndefined();
      // A newly accepted packet invalidates the old witness even before scene consumption.
      const second = f.receive();
      expect(old.source.isCurrent()).toBe(false);
      expect(f.decide(second)).toEqual({ miss: 'uncached', next: null });
      f.scene.consumePublication(second);
      const current = requiredSource(f);
      expect(current.source.isCurrent()).toBe(true);
      f.scene.dispose();
      expect(current.source.isCurrent()).toBe(false);
    } finally {
      f.dispose();
      other.dispose();
    }
  });

  it('rejects receiver base/revision regression and same-revision replacement without advancing authority', () => {
    const f = fixture();
    try {
      const accepted = f.receive();
      f.scene.consumePublication(accepted);
      const source = requiredSource(f).source;
      const next = f.receive();
      f.scene.consumePublication(next);
      const current = requiredSource(f);
      expect(f.receiver.accept(accepted.packet).ok).toBe(false);
      expect(
        f.receiver.accept({ ...next.packet, base: next.packet.revision, baseline: false }).ok,
      ).toBe(false);
      expect(current.source.isCurrent()).toBe(true);
      expect(source.isCurrent()).toBe(false);
      // A stale prepared input cannot mint a valid witness against newer receiver resources.
      f.scene.consumePublication(accepted);
      expect(requiredSource(f).source.isCurrent()).toBe(false);
      expect(f.decide(accepted)).toEqual({ miss: 'uncached', next: null });
    } finally {
      f.dispose();
    }
  });

  it('does not promote a submitted candidate if the accepted source changes at the transaction fence', () => {
    const f = fixture();
    try {
      f.publish();
      const source = requiredSource(f).source;
      let committed = 0;
      const aborted: string[] = [];
      const transaction = recordFrameTransaction(
        {
          build: () => ({ ok: true, value: undefined }),
          execute: () => ({ ok: true, value: undefined }),
          finish: () => ({ ok: true, value: undefined }),
          commit: () => {
            committed += 1;
          },
          abort: ({ stage }) => {
            aborted.push(stage);
          },
          generationFence: {
            capturedGeneration: 0,
            currentGeneration: () => (source.isCurrent() ? 0 : -1),
          },
        },
        {
          // The generator does not call either device/encoder: this fixture
          // exercises its real publication fence, not a physical submission.
          encoder: {} as RhiCommandEncoder,
          device: {} as RhiDevice,
          reportError: () => {
            throw new Error('unexpected encoder error');
          },
        },
      );
      const pending = transaction.next();
      expect(pending.done).toBe(false);
      f.receive();
      expect(source.isCurrent()).toBe(false);
      expect(transaction.next({ ok: true, value: undefined })).toEqual({
        done: true,
        value: { ok: false },
      });
      expect(committed).toBe(0);
      expect(aborted).toEqual(['submit']);
    } finally {
      f.dispose();
    }
  });

  it('refreshes resource/baseline/source, dispatch and residency replacements rather than staggering them', () => {
    const f = fixture();
    const replacement = fixture();
    try {
      const first = f.publish();
      f.state.directionalShadowCache = f.decide(first).next;
      f.world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
          { component: MeshRenderer, data: {} },
        )
        .unwrap();
      f.world.update(0).unwrap();
      const changed = f.publish();
      expect(f.decide(changed).miss).toBe('source-changed');
      f.state.directionalShadowCache = f.decide(changed).next;
      for (let frame = 0; frame < 60; frame += 1) {
        f.epochs.meshResidencyEpoch += 1;
        expect(f.decide(changed).miss).toBeUndefined();
      }
      f.mesh.contentEpoch += 1;
      expect(f.decide(changed).miss).toBe('source-changed');
      f.state.directionalShadowCache = f.decide(changed).next;
      f.validated[0] = { mesh: { ...f.mesh } };
      expect(f.decide(changed).miss).toBe('source-changed');
      f.state.directionalShadowCache = f.decide(changed).next;
      f.epochs.catalogEpoch += 1;
      expect(f.decide(changed).miss).toBe('source-changed');
      f.state.directionalShadowCache = f.decide(changed).next;
      const newBaseline = replacement.publish();
      const previous = requiredSource(f).source;
      f.scene.consumePublication(newBaseline);
      expect(previous.isCurrent()).toBe(false);
      expect(f.decide(newBaseline).miss).toBe('source-changed');
    } finally {
      f.dispose();
      replacement.dispose();
    }
  });
});
