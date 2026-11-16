import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { RenderFeatureBatchIncompleteError } from '../errors/render';
import { createRenderFeatureHost, type RenderFeatureFrameInput } from '../features/host';
import type { RenderFeature } from '../features/types';
import { addRenderFeatureSystem, renderFeatureSystemName } from '../world/feature-systems';
import { createRenderWorld, RenderPrepare } from '../world/render-world';
import { prepareFeatureFrame, submitFeatureFrame } from './feature-frame-driver';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const extracted: string[] = [];
  const feature = (identity: string): RenderFeature<undefined> => ({
    identity,
    extract: () => {
      extracted.push(identity);
      return ok(undefined);
    },
    plan: () => ok({ work: [] }),
  });
  const input = (frameNumber: number): RenderFeatureFrameInput => ({
    identity: 'view',
    render: true,
    world: new World(),
    frameNumber,
    caps: device.caps,
  });
  return { extracted, feature, input };
}

function featureSystems(world: ReturnType<typeof createRenderWorld>): readonly string[] {
  const schedule = world.scheduleData().find((entry) => entry.name === 'RenderPrepare');
  return (schedule?.systems ?? [])
    .map((system) => system.name)
    .filter((name) => name.startsWith('render-feature:'));
}

it('prepares each installed Feature as its own RenderPrepare system, in installation order', async () => {
  const { extracted, feature, input } = await fixture();
  const world = createRenderWorld();
  const registered = vi.spyOn(world, 'addSystems');
  const a = feature('a');
  const host = createRenderFeatureHost([a, feature('b')], world).unwrap();
  let removeReinstalled = () => {};
  try {
    host.install(feature('c')).unwrap();
    expect(featureSystems(world)).toEqual(['a', 'b', 'c'].map(renderFeatureSystemName));
    const registeredSystem = (identity: string) => {
      const system = registered.mock.calls
        .flatMap(([, , systems]) => systems)
        .find((system) => system.name === renderFeatureSystemName(identity));
      if (!system) throw new Error(`Missing fixture feature: ${identity}`);
      return system;
    };
    const [sa, sb, sc] = ['a', 'b', 'c'].map(
      (identity) =>
        world
          .scheduleData()
          .find((s) => s.name === 'RenderPrepare')
          ?.systems.find((s) => s.name === renderFeatureSystemName(identity))?.id,
    );
    const prepare = world.scheduleData().find((entry) => entry.name === 'RenderPrepare');
    expect(world.scheduleData().some((entry) => entry.name === 'RenderFeaturePrepare')).toBe(false);
    expect(prepare?.dependencies).toEqual(
      expect.arrayContaining([
        [sa, sb],
        [sb, sc],
      ]),
    );
    prepareFeatureFrame(host, [input(1)]);
    submitFeatureFrame(host);
    expect(extracted).toEqual(['a', 'b', 'c']);

    // An installed Feature whose system no longer runs seals an incomplete frame.
    world.removeSystem(RenderPrepare, registeredSystem('b')).unwrap();
    extracted.length = 0;
    let incomplete: unknown;
    try {
      prepareFeatureFrame(host, [input(2)]);
    } catch (error) {
      incomplete = error;
    }
    expect(incomplete).toBeInstanceOf(RenderFeatureBatchIncompleteError);
    expect((incomplete as RenderFeatureBatchIncompleteError).detail.missing).toEqual(['b']);
    expect(extracted).toEqual(['a', 'c']);
    removeReinstalled = addRenderFeatureSystem(world, 'b');
    extracted.length = 0;
    prepareFeatureFrame(host, [input(3)]);
    submitFeatureFrame(host);
    expect(extracted).toEqual(['a', 'c', 'b']);

    host.uninstall(a).unwrap();
    expect(featureSystems(world)).toEqual(['c', 'b'].map(renderFeatureSystemName));
  } finally {
    registered.mockRestore();
    removeReinstalled();
    host.dispose();
  }
  expect(featureSystems(world)).toEqual([]);
});

it('joins a Feature to an open frame at most once and never after the frame is sealed', async () => {
  const { feature, input } = await fixture();
  const host = createRenderFeatureHost([feature('a'), feature('b')]).unwrap();
  try {
    const frame = host.beginFrame([input(1)]);
    host.prepareFeature(frame, 'a');
    expect(() => host.prepareFeature(frame, 'a')).toThrow('at most once');
    expect(host.abortFrame(host.finishFrame(frame))).toEqual([]);
    expect(() => host.prepareFeature(frame, 'b')).toThrow('not open');
  } finally {
    host.dispose();
  }
});
