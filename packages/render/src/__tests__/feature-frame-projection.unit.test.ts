import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createFullscreenRenderFeature } from '../features/fullscreen';
import { createRenderFeatureHost, type RenderFeatureFrameInput } from '../features/host';
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
  it('keeps escaped frame summaries independent across view changes', () => {
    const world = new World();
    const host = createRenderFeatureHost([]).unwrap();
    const inputReports = [report(world, 9)];
    const first = host.runFrame([view('frame', [world], inputReports), view('view:"', [world])]);
    first.onAborted();
    inputReports.push(report(world, 10));
    const second = host.runFrame([view('other', [world])]);
    try {
      expect([...first.views.keys()]).toEqual(['frame', 'view:"']);
      expect([...second.views.keys()]).toEqual(['other']);
      expect(first.views.get('frame')?.hiddenEntityReports).toEqual([inputReports[0]]);
      expect(first.frame.hiddenEntityReports).toEqual([]);
      expect(Object.isFrozen(first.frame.hiddenEntityReports)).toBe(true);
      expect(first.views.get('view:"')?.hiddenEntityReports).toBe(first.frame.hiddenEntityReports);
      expect(second.frame.hiddenEntityReports).toEqual([]);
    } finally {
      second.onAborted();
      host.dispose();
    }
  });

  it('rejects duplicate view identities before publishing a batch', () => {
    const host = createRenderFeatureHost([]).unwrap();
    try {
      expect(() => host.runFrame([view('frame', []), view('frame', [])])).toThrow(
        'duplicate render view identity',
      );
    } finally {
      host.dispose();
    }
  });

  it('retains and deduplicates each view input without leaking sibling visibility', () => {
    const world = new World();
    const left = report(world, 9);
    const right = report(world, 10);
    const host = createRenderFeatureHost([]).unwrap();
    const batch = host.runFrame([
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
    const batch = host.runFrame([
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
    const batch = host.runFrame([view('left', [world]), view('right', [world])]);
    try {
      expect(batch.frame.errors).toEqual([]);
      for (const projected of batch.views.values()) {
        expect(projected.postProcessIdentities).toBe(batch.frame.postProcessIdentities);
        expect(Object.isFrozen(projected.postProcessIdentities)).toBe(true);
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
        const batch = host.runFrame([view('left', [world]), view('right', [world])]);
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
