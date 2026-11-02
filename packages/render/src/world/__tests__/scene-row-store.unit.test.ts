import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it, vi } from 'vitest';
import type { ExtractedFrame } from '../../render-system-extract';
import type { SceneAdvance, SceneComposition, SceneStage } from '../../scene/scene-composition';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderPrepare,
} from '../render-world';
import { RenderSceneRowStore } from '../scene-row-store';
import {
  RENDER_SCENE_PUBLISH_SYSTEM,
  type RenderSceneAdoption,
  RenderSceneDelta,
  RenderSceneRows,
  registerSceneSystem,
  sceneRowStep,
} from '../scene-systems';

const advance = { kind: 'advance' } as unknown as SceneAdvance;
const lights = { kind: 'roster' } as unknown as ExtractedFrame['lights'];

function fixture() {
  const calls: string[] = [];
  let next = 0;
  const stages: SceneStage[] = [];
  const extract = vi.fn(() => {
    const stage = { id: ++next } as unknown as SceneStage;
    stages.push(stage);
    return { advance, resourceFrame: { lights } as ExtractedFrame, stage };
  });
  const publishStage = vi.fn((stage: SceneStage) => {
    calls.push(`publish:${(stage as unknown as { id: number }).id}`);
  });
  const invalidate = vi.fn();
  const composition = {
    extract,
    publishStage,
    invalidate,
    adoptSkinInputs: vi.fn(),
    adoptInstanceCollections: vi.fn(),
    discardAdoption: vi.fn(),
  } as unknown as SceneComposition;
  const world = createRenderWorld();
  const source = registerSceneSystem(world, composition, {} as AssetRegistry);
  const failures = new Map<string, unknown>();
  const addStep = (name: string, before: readonly string[], after: readonly string[]) =>
    world
      .addSystem(RenderPrepare, {
        name,
        queries: [],
        before: [...before],
        after: [...after],
        fn: sceneRowStep(world, (stage) => {
          const cause = failures.get(name);
          if (cause !== undefined) throw cause;
          calls.push(`${name}:${(stage as unknown as { id: number }).id}`);
        }),
      })
      .unwrap();
  addStep('adopt', [RENDER_SCENE_PUBLISH_SYSTEM], []);
  addStep('plan', [RENDER_SCENE_PUBLISH_SYSTEM], ['adopt']);
  const frame = (index: number, staged: boolean): RenderSceneAdoption => {
    if (staged) {
      source.staged = true;
      source.buildCandidateFrame = () => ({}) as ExtractedFrame;
    }
    beginRenderFrame(world, index);
    endRenderFrame(world);
    return { ...world.getResource<RenderSceneAdoption>(RenderSceneDelta) };
  };
  return { world, calls, failures, frame, publishStage, invalidate, stages };
}

describe('RenderSceneRows row store', () => {
  it('is one Render World resource every row step consumes in schedule order', () => {
    const f = fixture();
    expect(f.world.getResource<RenderSceneRowStore>(RenderSceneRows)).toBeInstanceOf(
      RenderSceneRowStore,
    );
    f.frame(1, true);
    f.frame(2, true);
    expect(f.calls).toEqual(['adopt:1', 'plan:1', 'publish:1', 'adopt:2', 'plan:2', 'publish:2']);
  });

  it('consumes each applied step once and visits nothing on an idle frame', () => {
    const f = fixture();
    f.frame(1, true);
    f.calls.length = 0;
    const idle = f.frame(2, false);
    f.frame(3, false);
    expect(f.calls).toEqual([]);
    expect(idle.failure).toBeUndefined();
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it('stores the first failure once, gates every later step and leaves the step unaccepted', () => {
    const f = fixture();
    const cause = new Error('dispatch failed');
    f.failures.set('adopt', cause);
    const failed = f.frame(1, true);
    expect(failed.failure).toBe(cause);
    expect(f.calls).toEqual([]);
    expect(f.publishStage).not.toHaveBeenCalled();
    // A non-staging frame neither reruns nor reports the old failure.
    f.failures.clear();
    expect(f.frame(2, false).failure).toBeUndefined();
    expect(f.calls).toEqual([]);
    // The next applied step (the re-observation) reaches every consumer again.
    f.frame(3, true);
    expect(f.calls).toEqual(['adopt:2', 'plan:2', 'publish:2']);
    expect(f.invalidate).not.toHaveBeenCalled();
  });

  it('skips a step whose frame already failed and keeps the cursor current', () => {
    const rows = new RenderSceneRowStore({ invalidate: vi.fn() } as unknown as SceneComposition);
    const cursor = rows.cursor();
    rows.append({ id: 1 } as unknown as SceneStage);
    expect(rows.next(cursor, { failure: new Error('scene retired') })).toBeUndefined();
    expect(rows.next(cursor, { failure: undefined })).toBeUndefined();
  });
});

describe('RenderSceneRowStore cursor loss', () => {
  const composition = () => ({ invalidate: vi.fn() }) as unknown as SceneComposition;
  const ok = { failure: undefined };
  const step = (id: number) => ({ id }) as unknown as SceneStage;

  it('drops the composition when a consumer skipped an applied step', () => {
    const scene = composition();
    const rows = new RenderSceneRowStore(scene);
    const late = rows.cursor();
    rows.append(step(1));
    rows.append(step(2));
    expect(() => rows.next(late, ok)).toThrow(/missed an applied step/);
    expect(scene.invalidate).toHaveBeenCalledTimes(1);
    // The cursor is current again; the next applied step patches normally.
    rows.append(step(3));
    expect(rows.next(late, ok)).toEqual(step(3));
  });

  it('drops the composition when the step a consumer missed was already released', () => {
    const scene = composition();
    const rows = new RenderSceneRowStore(scene);
    const late = rows.cursor();
    rows.append(step(1));
    rows.append(undefined);
    expect(() => rows.next(late, ok)).toThrow(/missed an applied step/);
    expect(scene.invalidate).toHaveBeenCalledTimes(1);
  });

  it('returns the head step to a cursor one behind and nothing to a current cursor', () => {
    const rows = new RenderSceneRowStore(composition());
    const cursor = rows.cursor();
    const head = step(1);
    rows.append(head);
    expect(rows.next(cursor, ok)).toBe(head);
    expect(rows.next(cursor, ok)).toBeUndefined();
  });
});
