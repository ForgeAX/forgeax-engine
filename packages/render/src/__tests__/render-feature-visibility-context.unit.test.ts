import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { RhiNullCommandEncoder, RhiNullDevice, RhiNullQueue } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { captureHiddenEntityReports } from '../features/hidden-entity-reports';
import { createRenderFeatureHost } from '../features/host';
import type { RenderFeature, RenderFeatureHiddenEntityReport } from '../features/types';
import { runSingleViewFeatureFrame } from './single-view-feature-fixture';

describe('render feature visibility context', () => {
  it('passes the same batch visibility context to every feature', () => {
    const world = new World();
    let receivedSnapshots: unknown;
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-context',
      extract: (context) => {
        receivedSnapshots = context.visibilitySnapshot;
        context.reportHiddenEntity?.({ entity: 7 as never });
        return ok({ count: context.world.inspect().entityCount });
      },
      plan: () => ok({ work: [{ scope: { view: 'main' }, resources: [], passes: [] }] }),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const snapshots = {} as never;
    const builtIn: RenderFeatureHiddenEntityReport = { entity: 7 as never };
    const result = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 1,
      caps: {} as never,
      visibilitySnapshot: snapshots,
      hiddenEntityReports: [builtIn],
    });

    expect(receivedSnapshots).toBe(snapshots);
    expect(result.hiddenEntityReports).toHaveLength(1);
    expect(result.hiddenEntityReports[0]).toEqual(builtIn);
  });
});

it.each([
  'borrowed',
  'captured',
] as const)('accepts a large %s hidden population without expanding call arguments', (kind) => {
  const world = new World();
  const host = createRenderFeatureHost([]).unwrap();
  try {
    const input = Array.from({ length: 150_000 }, (_, entity) => ({
      world,
      entity: entity as EntityHandle,
    }));
    const hiddenEntityReports = kind === 'captured' ? captureHiddenEntityReports(input) : input;
    const result = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 1,
      caps: new RhiNullDevice(
        new RhiNullQueue(),
        (bookkeeper, descriptor) => new RhiNullCommandEncoder(bookkeeper, descriptor),
      ).caps,
      hiddenEntityReports,
    });
    if (kind === 'captured') expect(result.hiddenEntityReports).toBe(hiddenEntityReports);
    expect(result.hiddenEntityReports).toHaveLength(150_000);
    expect(result.hiddenEntityReports[149_999]?.entity).toBe(149_999);
  } finally {
    host.dispose();
  }
});

it('keeps fixed producer reports and held results independently of later input mutation', () => {
  const world = new World();
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, descriptor) => new RhiNullCommandEncoder(bookkeeper, descriptor),
  );
  const host = createRenderFeatureHost([]).unwrap();
  try {
    const input = [{ entity: 1 as EntityHandle }, { entity: 1 as EntityHandle }];
    const reports = captureHiddenEntityReports(input);
    const first = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 1,
      caps: device.caps,
      hiddenEntityReports: reports,
    });
    expect(first.hiddenEntityReports).toBe(reports);
    expect(first.hiddenEntityReports).toHaveLength(1);
    input[0] = { entity: 2 as EntityHandle };
    const next = runSingleViewFeatureFrame(host, {
      world: world,
      frameNumber: 2,
      caps: device.caps,
      hiddenEntityReports: captureHiddenEntityReports(input),
    });
    expect(next.hiddenEntityReports.map((row) => row.entity)).toEqual([2, 1]);
    expect(first.hiddenEntityReports[0]?.entity).toBe(1);
    expect(Object.isFrozen(reports)).toBe(true);
    expect(Object.isFrozen(reports[0])).toBe(true);
  } finally {
    host.dispose();
  }
});

it('keeps borrowed descendants live through each frame', () => {
  const world = new World();
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, descriptor) => new RhiNullCommandEncoder(bookkeeper, descriptor),
  );
  let entity = 1 as EntityHandle;
  let reads = 0;
  const borrowed = Object.freeze([
    {
      world,
      get entity() {
        reads++;
        return entity;
      },
    },
  ]);
  const host = createRenderFeatureHost([]).unwrap();
  try {
    const run = (reports: readonly RenderFeatureHiddenEntityReport[]) =>
      runSingleViewFeatureFrame(host, {
        world: world,
        frameNumber: 1,
        caps: device.caps,
        hiddenEntityReports: reports,
      });
    expect(run(borrowed).hiddenEntityReports[0]?.entity).toBe(1);
    const previousReads = reads;
    entity = 2 as EntityHandle;
    expect(run(borrowed).hiddenEntityReports[0]?.entity).toBe(2);
    expect(reads).toBeGreaterThan(previousReads);
  } finally {
    host.dispose();
  }
});

it('merges fixed producer reports with custom additions by source entity handle in original order', () => {
  const first = new World();
  const device = new RhiNullDevice(
    new RhiNullQueue(),
    (bookkeeper, descriptor) => new RhiNullCommandEncoder(bookkeeper, descriptor),
  );
  const feature: RenderFeature<undefined> = {
    identity: 'fixture.fixed-hidden-additions',
    extract(context) {
      context.reportHiddenEntity?.({ entity: 7 as EntityHandle });
      context.reportHiddenEntity?.({ entity: 8 as EntityHandle });
      return ok(undefined);
    },
    plan: () => ok({ work: [] }),
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  try {
    const reports = captureHiddenEntityReports([{ entity: 7 as EntityHandle }]);
    const result = runSingleViewFeatureFrame(host, {
      world: first,
      frameNumber: 1,
      caps: device.caps,
      hiddenEntityReports: reports,
    });
    expect(result.hiddenEntityReports).toEqual([{ entity: 7 }, { entity: 8 }]);
    expect(result.hiddenEntityReports).not.toBe(reports);
    expect(reports).toHaveLength(1);
  } finally {
    host.dispose();
  }
});
