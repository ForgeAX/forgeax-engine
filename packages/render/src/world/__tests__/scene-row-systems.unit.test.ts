import type { EntityHandle } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { SceneComposition } from '../../scene/scene-composition';
import { ViewRecorder, ViewSubmission } from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  renderSubmission,
} from '../render-world';
import { registerSceneRowSystems } from '../scene-row-systems';
import { withInertTemporal } from './temporal-owner-fixture';

it('commits accepted scene attempts of the current frame once, with their temporal demand', () => {
  const world = createRenderWorld();
  const commitFrame = vi.fn(() => ok(undefined));
  registerSceneRowSystems(world, { commitFrame } as unknown as SceneComposition, () => {});
  const views = [0, 1].map(() =>
    world
      .spawn({
        component: ViewSubmission,
        data: { accepted: false, attempt: 0, scene: false, temporal: false },
      })
      .unwrap(),
  );
  type View = { accepted?: boolean; attempt?: number; scene?: boolean; temporal?: boolean };
  const frame = (number: number, accepted: boolean, ...facts: View[]) => {
    beginRenderFrame(world, number);
    for (const [index, view] of views.entries()) {
      world
        .set(view, ViewSubmission, {
          accepted: true,
          attempt: number,
          scene: true,
          temporal: false,
          ...facts[index],
        })
        .unwrap();
    }
    renderSubmission(world).accepted = accepted;
    endRenderFrame(world);
  };
  // A preparation barrier submits no scene draws.
  frame(1, true, { scene: false }, { scene: false });
  expect(commitFrame).not.toHaveBeenCalled();
  // Two scene views still advance the shared rows once.
  frame(2, true, {}, { temporal: true });
  expect(commitFrame.mock.calls).toEqual([[true]]);
  // A rejected submission, and stale or rejected view attempts, commit nothing.
  frame(3, false, {}, {});
  frame(4, true, { attempt: 3 }, { accepted: false });
  frame(5, true, { temporal: false }, { scene: false, temporal: true });
  expect(commitFrame.mock.calls).toEqual([[true], [false]]);
});

it('adopts each view raster lane only for its accepted attempt of the current frame', () => {
  const world = createRenderWorld();
  registerSceneRowSystems(
    world,
    { commitFrame: () => ok(undefined) } as unknown as SceneComposition,
    () => {},
  );
  const commits = [vi.fn(), vi.fn(), vi.fn()];
  const views = commits.map((commitRasterLane) =>
    world
      .spawn(
        {
          component: ViewSubmission,
          data: { accepted: false, attempt: 0, scene: false, temporal: false },
        },
        {
          component: ViewRecorder,
          data: {
            state: world.allocUniqueRef(
              'ViewRecorder',
              withInertTemporal({}, { scene: { commitRasterLane } }),
            ),
          },
        },
      )
      .unwrap(),
  );
  beginRenderFrame(world, 7);
  const facts = [
    { accepted: true, attempt: 7 },
    { accepted: false, attempt: 7 },
    { accepted: true, attempt: 6 },
  ] as const;
  for (const [index, fact] of facts.entries())
    world
      .set(views[index] as EntityHandle, ViewSubmission, { scene: false, temporal: false, ...fact })
      .unwrap();
  endRenderFrame(world);
  expect(commits.map((commit) => commit.mock.calls.length)).toEqual([1, 0, 0]);
});
