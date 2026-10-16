import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createFullscreenRenderFeature } from '../features/fullscreen';
import {
  createRenderFeatureHost,
  type RenderFeatureFrameInput,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeature, RenderFeatureHiddenEntityReport } from '../features/types';

function view(
  identity: string,
  worlds: readonly World[],
  hiddenEntityReports: readonly RenderFeatureHiddenEntityReport[] = [],
): RenderFeatureFrameInput {
  return {
    identity,
    render: true,
    worlds,
    owner: 0,
    frameNumber: 1,
    caps: {} as never,
    hiddenEntityReports,
  };
}

function report(world: World, entity: number): RenderFeatureHiddenEntityReport {
  return { world, entity: entity as never };
}

function keys(reports: readonly RenderFeatureHiddenEntityReport[] | undefined) {
  return reports?.map(({ world, entity }) => `${world.identity}:${entity}`);
}

describe('Feature frame projections preserve renderer inputs', () => {
  it('retains and deduplicates each view input without leaking sibling visibility', () => {
    const world = new World();
    const left = report(world, 9);
    const right = report(world, 10);
    const host = createRenderFeatureHost([]).unwrap();
    const batch = runRenderFeatureFrame(host, [
      view('left', [world], [left, left]),
      view('right', [world], [right, right]),
    ]);
    try {
      expect(batch.frame.errors).toEqual([]);
      expect(keys(batch.views.get('left')?.hiddenEntityReports)).toEqual(keys([left]));
      expect(keys(batch.views.get('right')?.hiddenEntityReports)).toEqual(keys([right]));
    } finally {
      batch.onAborted();
      host.dispose();
    }
  });

  it.each([
    'frame',
    'empty',
  ] as const)('projects successful extract reports with %s work into every view once', (work) => {
    const world = new World();
    const otherWorld = new World();
    const left = report(world, 9);
    const right = report(world, 10);
    const shared = report(world, 11);
    const sameEntityInOtherWorld = report(otherWorld, 11);
    const feature: RenderFeature<unknown> = {
      identity: 'review.visibility',
      extract: (context) => {
        for (const entry of [shared, shared, sameEntityInOtherWorld])
          context.reportHiddenEntity?.(entry);
        return ok(undefined);
      },
      plan: () =>
        ok({ work: work === 'empty' ? [] : [{ scope: 'frame', resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const batch = runRenderFeatureFrame(host, [
      view('left', [world, otherWorld], [left, shared]),
      view('right', [world, otherWorld], [right, shared]),
    ]);
    try {
      expect(batch.frame.errors).toEqual([]);
      expect(keys(batch.views.get('left')?.hiddenEntityReports)).toEqual(
        keys([left, shared, sameEntityInOtherWorld]),
      );
      expect(keys(batch.views.get('right')?.hiddenEntityReports)).toEqual(
        keys([right, shared, sameEntityInOtherWorld]),
      );
    } finally {
      batch.onAborted();
      host.dispose();
    }
  });

  it('projects fullscreen identities in declaration order, independently of shader aliases', () => {
    const world = new World();
    const source = '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }';
    const first = createFullscreenRenderFeature({ identity: 'z::overlay', source });
    const second = createFullscreenRenderFeature({ identity: 'a::inversion', source });
    const features = [
      {
        ...first,
        requiredFullscreenPostProcesses: [
          ...(first.requiredFullscreenPostProcesses ?? []),
          ...(first.requiredFullscreenPostProcesses ?? []),
        ],
      },
      second,
    ];
    const host = createRenderFeatureHost(features).unwrap();
    const batch = runRenderFeatureFrame(host, [view('left', [world]), view('right', [world])]);
    try {
      expect(batch.frame.errors).toEqual([]);
      for (const projected of batch.views.values()) {
        expect(projected.fullscreenEffects.has(first.identity)).toBe(true);
        expect(projected.fullscreenEffects.has(second.identity)).toBe(true);
        expect(projected.postProcessIdentities).toEqual([first.identity, second.identity]);
        const aliases = [...projected.fullscreenEffects.keys()].filter(
          (id) => id !== first.identity && id !== second.identity,
        );
        expect(aliases).toHaveLength(2);
        expect(aliases.every((id) => !projected.postProcessIdentities.includes(id))).toBe(true);
      }
    } finally {
      batch.onAborted();
      host.dispose();
    }
  });
  it('admits only fullscreen programs present in the current successful plan', () => {
    const world = new World();
    const source = '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }';
    const fullscreen = createFullscreenRenderFeature({ identity: 'game::optional', source });
    let enabled = false;
    const feature = {
      ...fullscreen,
      plan: () => (enabled ? fullscreen.plan(undefined, {} as never) : ok({ work: [] })),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    try {
      for (const active of [false, true, false, true]) {
        enabled = active;
        const batch = runRenderFeatureFrame(host, [view('left', [world]), view('right', [world])]);
        try {
          expect(batch.frame.errors).toEqual([]);
          for (const projected of batch.views.values()) {
            expect(projected.postProcessIdentities).toEqual(active ? [feature.identity] : []);
            expect(projected.fullscreenEffects.has(feature.identity)).toBe(active);
          }
        } finally {
          batch.onAborted();
        }
      }
    } finally {
      host.dispose();
    }
  });
});
