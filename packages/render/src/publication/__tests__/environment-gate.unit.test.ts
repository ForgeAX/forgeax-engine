import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, Time, World } from '@forgeax/engine-ecs';
import { worldRead } from '@forgeax/engine-ecs/world-read';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { GlobalTransform, Transform, TransformInterpolation } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  MotionBlur,
  PointLight,
} from '../../components';
import {
  EnvironmentGate,
  queryEnvironment,
  readEnvironmentPose,
} from '../../extract/environment-gate';
import * as environmentExtraction from '../../extract/world-environment';
import { Materials } from '../../materials';
import { setActiveCamera } from '../../systems/active-camera';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';
import { renderPublicationTransfers } from '../record';

vi.mock('../../extract/world-environment', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../extract/world-environment')>();
  return { ...original, extractWorldEnvironment: vi.fn(original.extractWorldEnvironment) };
});

const extractions = vi.mocked(environmentExtraction.extractWorldEnvironment);

function session() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const cube = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const material = assets.create(Materials.standard({ baseColor: [1, 1, 1, 1] })).unwrap();
  const identity = { source: 'environment-gate-test', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 5] } },
      { component: Camera, data: { fov: Math.PI / 3 } },
    )
    .unwrap();
  const sun = world
    .spawn({ component: DirectionalLight, data: { direction: [0.2, -1, 0.1], castShadow: true } })
    .unwrap();
  const lamp = world
    .spawn(
      { component: Transform, data: { pos: [2, 2, 0] } },
      { component: PointLight, data: { intensity: 4 } },
    )
    .unwrap();
  const box = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: cube } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  const receiver = new RenderPublicationReceiver(identity);
  const frame = () => {
    const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
    const sent = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(sent);
    if (!accepted.ok) throw accepted.error;
    const metadata = accepted.value.packet.metadata;
    const returned = structuredClone(renderPublicationTransfers(sent), {
      transfer: renderPublicationTransfers(sent),
    });
    publisher.recycle(sent.revision, returned).unwrap();
    return { side: sent.side, metadata };
  };
  return {
    world,
    camera,
    sun,
    lamp,
    box,
    frame,
    dispose() {
      publisher.dispose();
      receiver.dispose();
    },
  };
}

describe('change-driven source environment', () => {
  it('keeps static light reads out of moving-camera extraction while admitting light changes', () => {
    const s = session();
    try {
      const first = s.frame();
      const read = vi.spyOn(s.world[worldRead], 'getFieldValue');
      try {
        for (let index = 1; index <= 3; index++) {
          s.world.set(s.camera, Transform, { pos: [index, 0, 5] }).unwrap();
          s.world.update(1 / 60).unwrap();
          expect(s.frame().metadata.lights).toBe(first.metadata.lights);
        }
        expect(
          read.mock.calls.filter(
            ([, component]) => component === DirectionalLight || component === PointLight,
          ),
        ).toHaveLength(0);
        s.world.set(s.lamp, PointLight, { intensity: 9 }).unwrap();
        expect(s.frame().metadata.lights.point[0]?.intensity).toBe(9);
        expect(first.metadata.lights.point[0]?.intensity).toBe(4);
        s.world.removeComponent(s.lamp, PointLight).unwrap();
        expect(s.frame().metadata.lights.point).toHaveLength(0);
      } finally {
        read.mockRestore();
      }
    } finally {
      s.dispose();
    }
  });

  it('retains stock Query instances while moving extraction keeps current membership and optional fields', () => {
    const s = session();
    try {
      s.frame();
      const queries = vi.spyOn(s.world, 'query');
      for (let index = 1; index <= 3; index++) {
        s.world.set(s.camera, Transform, { pos: [index, 0, 5] }).unwrap();
        s.world.update(1 / 60).unwrap();
        expect(s.frame().metadata.cameras).toHaveLength(1);
      }
      const stockQueries = queries.mock.calls.filter(
        ([descriptor]) =>
          descriptor.read?.includes(Camera) ||
          descriptor.read?.includes(PointLight) ||
          descriptor.read?.includes(DirectionalLight),
      );
      expect(stockQueries).toHaveLength(0);
      s.world.addComponent(s.camera, { component: MotionBlur, data: { shutterAngle: 0 } }).unwrap();
      expect(s.frame().metadata.cameras).toHaveLength(1);
      s.world.removeComponent(s.lamp, PointLight).unwrap();
      expect(s.frame().metadata.lights.point).toHaveLength(0);
      queries.mockRestore();
    } finally {
      s.dispose();
    }
  });

  it('ignores unrelated writes while preserving published values', () => {
    const s = session();
    const Clock = defineComponent('EnvironmentUnrelatedClock', { value: 'f32' });
    const clock = s.world.spawn({ component: Clock, data: { value: 0 } }).unwrap();
    try {
      s.world.update(1 / 60).unwrap();
      const first = s.frame();
      extractions.mockClear();
      for (let frame = 1; frame <= 3; frame += 1) {
        s.world.set(clock, Clock, { value: frame }).unwrap();
        s.world.update(1 / 60).unwrap();
        const next = s.frame();
        expect(next.metadata.lights).toBe(first.metadata.lights);
        expect(next.metadata.cameras).toBe(first.metadata.cameras);
      }
      expect(extractions).not.toHaveBeenCalled();
    } finally {
      s.dispose();
    }
  });

  it('ignores unrelated membership while admitting environment removal and new generations', () => {
    const s = session();
    const Other = defineComponent('EnvironmentUnrelatedMembership', { value: 'f32' });
    try {
      const first = s.frame();
      extractions.mockClear();
      const other = s.world.spawn({ component: Other, data: {} }).unwrap();
      s.frame();
      s.world.despawn(other).unwrap();
      s.frame();
      expect(extractions).not.toHaveBeenCalled();
      s.world.removeComponent(s.lamp, PointLight).unwrap();
      const removed = s.frame();
      expect(removed.metadata.lights.point).toHaveLength(0);
      expect(first.metadata.lights.point).toHaveLength(1);
      s.world.addComponent(s.lamp, { component: PointLight, data: { intensity: 9 } }).unwrap();
      expect(s.frame().metadata.lights.point[0]?.intensity).toBe(9);
      s.world.despawn(s.lamp).unwrap();
      expect(s.frame().metadata.lights.point).toHaveLength(0);
      s.world
        .spawn(
          { component: PointLight, data: { intensity: 12 } },
          { component: Transform, data: {} },
        )
        .unwrap();
      s.world.update(1 / 60).unwrap();
      expect(s.frame().metadata.lights.point[0]?.intensity).toBe(12);
      expect(extractions).toHaveBeenCalledTimes(4);
    } finally {
      s.dispose();
    }
  });

  it('observes optional camera membership, missing pose joins and ActiveCamera resource values', () => {
    const s = session();
    try {
      const second = s.world.spawn({ component: Camera, data: { fov: Math.PI / 4 } }).unwrap();
      const first = s.frame();
      s.world.addComponent(s.camera, { component: MotionBlur, data: {} }).unwrap();
      expect(s.frame().metadata.cameras[0]?.motionBlur).toBeDefined();
      s.world.removeComponent(s.camera, MotionBlur).unwrap();
      expect(s.frame().metadata.cameras[0]?.motionBlur).toBeUndefined();
      s.world.addComponent(second, { component: Transform, data: { pos: [1, 2, 3] } }).unwrap();
      s.world.update(1 / 60).unwrap();
      setActiveCamera(s.world, second);
      expect(s.frame().metadata.cameras[0]?.entityKey).toBe(Number(second));
      expect(first.metadata.cameras[0]?.entityKey).toBe(Number(s.camera));
      s.world.removeComponent(second, GlobalTransform).unwrap();
      s.world.removeComponent(second, Transform).unwrap();
      s.world.update(1 / 60).unwrap();
      expect(s.frame().metadata.cameras[0]?.entityKey).toBe(Number(s.camera));
    } finally {
      s.dispose();
    }
  });

  it('extracts no environment while only renderables move', () => {
    const s = session();
    try {
      const first = s.frame();
      extractions.mockClear();
      for (let frame = 0; frame < 3; frame += 1) {
        s.world.set(s.box, Transform, { pos: [frame + 1, 0, 0] }).unwrap();
        s.world.update(1 / 60).unwrap();
        const next = s.frame();
        // Only renderable statistics may follow a moving renderable.
        expect(
          Object.keys(next.side?.metadata ?? {}).filter((key) => !key.endsWith('Stats')),
        ).toEqual([]);
        expect(next.metadata.lights).toBe(first.metadata.lights);
        expect(next.metadata.cameras).toBe(first.metadata.cameras);
      }
      expect(extractions).not.toHaveBeenCalled();
    } finally {
      s.dispose();
    }
  });

  it('publishes only the entries whose inputs changed', () => {
    const s = session();
    try {
      const first = s.frame();
      // A moved camera is a camera change: the lights entry keeps its identity.
      s.world.set(s.camera, Transform, { pos: [1, 0, 5] }).unwrap();
      s.world.update(1 / 60).unwrap();
      const moved = s.frame();
      expect(Object.keys(moved.side?.metadata ?? {})).toContain('cameras');
      expect(Object.keys(moved.side?.metadata ?? {})).not.toContain('lights');
      expect(moved.metadata.lights).toBe(first.metadata.lights);
      // A light edit publishes the lights entry; cameras stay as they were.
      s.world.set(s.lamp, PointLight, { intensity: 8 }).unwrap();
      s.world.update(1 / 60).unwrap();
      const lit = s.frame();
      expect(Object.keys(lit.side?.metadata ?? {})).toContain('lights');
      expect(Object.keys(lit.side?.metadata ?? {})).not.toContain('cameras');
      expect(lit.metadata.cameras).toBe(moved.metadata.cameras);
      expect(lit.metadata.lights.point[0]?.intensity).not.toBe(
        first.metadata.lights.point[0]?.intensity,
      );
      // A moved light is a pose input of the extraction.
      s.world.set(s.lamp, Transform, { pos: [3, 2, 0] }).unwrap();
      s.world.update(1 / 60).unwrap();
      const relit = s.frame();
      expect(relit.metadata.lights.point[0]?.position[0]).toBeCloseTo(3);
      expect(relit.metadata.cameras).toBe(moved.metadata.cameras);
    } finally {
      s.dispose();
    }
  });
});

describe('EnvironmentGate inputs', () => {
  it('keeps a foreign-World nested observation conservative', () => {
    const parentWorld = new World(),
      childWorld = new World();
    const Input = defineComponent('ForeignNestedInput', { value: 'f32' });
    const entity = childWorld.spawn({ component: Input, data: { value: 1 } }).unwrap();
    const outer = new EnvironmentGate<number>(true),
      inner = new EnvironmentGate<number>(true);
    outer.assetsChanged = inner.assetsChanged = false;
    const read = () =>
      outer.read(parentWorld, 'outer', () => ({
        value: inner.read(childWorld, 'inner', () => {
          queryEnvironment(childWorld, { read: [Input] }).unwrap();
          return {
            value: childWorld[worldRead].getFieldValue(entity, Input, 'value') as number,
            timeDependent: false,
          };
        }),
        timeDependent: false,
      }));
    expect(read()).toBe(1);
    childWorld.set(entity, Input, { value: 2 }).unwrap();
    expect(read()).toBe(2);
  });

  it('observes successful nested inputs on both child misses and cache hits', () => {
    const world = new World();
    const Input = defineComponent('NestedSuccessfulInput', { value: 'f32' });
    const entity = world.spawn({ component: Input, data: { value: 1 } }).unwrap();
    const outer = new EnvironmentGate<number>(true),
      inner = new EnvironmentGate<number>(true);
    outer.assetsChanged = inner.assetsChanged = false;
    let key = 'first',
      innerRuns = 0;
    const read = () =>
      outer.read(world, key, () => ({
        value: inner.read(world, 'inner', () => {
          innerRuns++;
          queryEnvironment(world, { read: [Input] }).unwrap();
          return {
            value: world[worldRead].getFieldValue(entity, Input, 'value') as number,
            timeDependent: false,
          };
        }),
        timeDependent: false,
      }));
    expect(read()).toBe(1);
    key = 'replacement';
    expect(read()).toBe(1);
    expect(innerRuns).toBe(1);
    world.set(entity, Input, { value: 2 }).unwrap();
    expect(read()).toBe(2);
    expect(innerRuns).toBe(2);
  });

  it('propagates a nested time-dependent observation to its parent', () => {
    const world = new World();
    const outer = new EnvironmentGate<number>(true),
      inner = new EnvironmentGate<number>(true);
    outer.assetsChanged = inner.assetsChanged = false;
    let runs = 0;
    const read = () =>
      outer.read(world, 'outer', () => ({
        value: inner.read(world, 'inner', () => ({ value: ++runs, timeDependent: true })),
        timeDependent: false,
      }));
    expect(read()).toBe(1);
    expect(read()).toBe(2);
  });

  it('conservatively observes every non-pose component for arbitrary extractors', () => {
    const world = new World();
    const Input = defineComponent('EnvironmentExplicitInput', { value: 'f32' });
    const Other = defineComponent('EnvironmentOtherInput', { value: 'f32' });
    const entity = world
      .spawn({ component: Input, data: { value: 1 } }, { component: Other, data: { value: 1 } })
      .unwrap();
    const gate = new EnvironmentGate<number>();
    gate.assetsChanged = false;
    let runs = 0;
    const read = () => gate.read(world, 'key', () => ({ value: ++runs, timeDependent: false }));
    read();
    world.set(entity, Other, { value: 2 }).unwrap();
    read();
    expect(runs).toBe(2);
    world.set(entity, Input, { value: 2 }).unwrap();
    read();
    expect(runs).toBe(3);
  });

  it('restores actual input observation after nested and failed extractions', () => {
    const world = new World();
    const Input = defineComponent('EnvironmentObservedInput', { value: 'f32' });
    const Other = defineComponent('EnvironmentNestedInput', { value: 'f32' });
    const entity = world
      .spawn({ component: Input, data: {} }, { component: Other, data: {} })
      .unwrap();
    const outer = new EnvironmentGate<number>(true);
    const inner = new EnvironmentGate<number>(true);
    outer.assetsChanged = inner.assetsChanged = false;
    let runs = 0;
    const read = () =>
      outer.read(world, 'outer', () => {
        runs++;
        expect(() =>
          inner.read(world, 'inner', () => {
            queryEnvironment(world, { read: [Other] }).unwrap();
            throw new Error('probe');
          }),
        ).toThrow('probe');
        queryEnvironment(world, { read: [Input] }).unwrap();
        return { value: runs, timeDependent: false };
      });
    expect(read()).toBe(1);
    world.set(entity, Other, { value: 2 }).unwrap();
    expect(read()).toBe(1);
    world.set(entity, Input, { value: 2 }).unwrap();
    expect(read()).toBe(2);
  });

  function gated() {
    const world = new World();
    const entity = world.spawn({ component: Transform, data: { pos: [0, 0, 0] } }).unwrap();
    world.update(1 / 60).unwrap();
    const gate = new EnvironmentGate<number>();
    gate.assetsChanged = false;
    let runs = 0;
    const read = (options: { timeDependent?: boolean; route?: boolean } = {}) =>
      gate.read(world, 'key', (routedError) => {
        runs += 1;
        readEnvironmentPose(world, entity);
        if (options.route === true) routedError();
        return { value: runs, timeDependent: options.timeDependent === true };
      });
    return { world, entity, gate, read, runs: () => runs };
  }

  it('reuses the extraction until a component, structure, pose or asset input changes', () => {
    const g = gated();
    g.read();
    g.read();
    expect(g.runs()).toBe(1);
    g.gate.assetsChanged = true;
    g.read();
    expect(g.runs()).toBe(2);
    g.gate.assetsChanged = false;
    g.world.set(g.entity, Transform, { pos: [1, 0, 0] }).unwrap();
    g.read();
    expect(g.runs()).toBe(3);
    g.world.spawn({ component: Transform, data: {} }).unwrap();
    g.read();
    expect(g.runs()).toBe(4);
    g.read();
    expect(g.runs()).toBe(4);
  });

  it('reruns an extraction that read Time, routed an error or read an interpolated pose', () => {
    const g = gated();
    g.read({ timeDependent: true });
    g.read();
    expect(g.runs()).toBe(2);
    g.world.set(g.entity, Transform, { pos: [1, 0, 0] }).unwrap();
    g.read({ route: true });
    g.read();
    expect(g.runs()).toBe(4);
    g.world.addComponent(g.entity, { component: TransformInterpolation, data: {} }).unwrap();
    g.read();
    g.read();
    expect(g.runs()).toBe(6);
  });
});
