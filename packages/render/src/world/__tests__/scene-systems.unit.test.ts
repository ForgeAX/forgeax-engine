import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { describe, expect, it, vi } from 'vitest';
import type { PreparedRenderPublication } from '../../publication/receiver';
import type { ExtractedFrame } from '../../render-system-extract';
import type { SceneAdvance, SceneComposition } from '../../scene/scene-composition';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderExtract,
} from '../render-world';
import {
  INSTANCE_COLLECTIONS_SYSTEM,
  RENDER_SCENE_SYSTEM,
  RenderLightInput,
  type RenderLightSource,
  type RenderSceneAdoption,
  RenderSceneDelta,
  registerSceneSystem,
  SKIN_INPUTS_SYSTEM,
} from '../scene-systems';

const advance = { kind: 'advance' } as unknown as SceneAdvance;
const lights = { kind: 'roster' } as unknown as ExtractedFrame['lights'];

function scene() {
  const consume = vi.fn(() => ({ advance, stage: undefined }));
  const extract = vi.fn(() => ({ advance, resourceFrame: { lights } as ExtractedFrame }));
  const adoptSkinInputs = vi.fn();
  const adoptInstanceCollections = vi.fn();
  const discardAdoption = vi.fn();
  const world = createRenderWorld();
  const source = registerSceneSystem(
    world,
    {
      consume,
      extract,
      adoptSkinInputs,
      adoptInstanceCollections,
      discardAdoption,
    } as unknown as SceneComposition,
    {} as AssetRegistry,
  );
  const adoption = () => world.getResource<RenderSceneAdoption>(RenderSceneDelta);
  const roster = () => world.getResource<RenderLightSource>(RenderLightInput).roster;
  return {
    world,
    source,
    consume,
    extract,
    adoptSkinInputs,
    adoptInstanceCollections,
    discardAdoption,
    adoption,
    roster,
  };
}

describe('render-scene system', () => {
  it('runs in RenderExtract and adopts the staged Worlds once per frame', () => {
    const s = scene();
    const extract = s.world.scheduleData().find((schedule) => schedule.name === 'RenderExtract');
    expect(extract?.systems.map((system) => system.name)).toContain(RENDER_SCENE_SYSTEM);
    s.source.staged = true;
    s.source.buildCandidateFrame = () => ({}) as ExtractedFrame;
    beginRenderFrame(s.world, 1);
    endRenderFrame(s.world);
    expect(s.extract).toHaveBeenCalledTimes(1);
    expect(s.adoption().advance).toBe(advance);
    expect(s.roster()).toBe(lights);
    expect(s.source.buildCandidateFrame).toBeUndefined();
    beginRenderFrame(s.world, 2);
    expect(s.extract).toHaveBeenCalledTimes(1);
    expect(s.adoption().advance).toBeUndefined();
  });

  it('adopts a staged publication and its light roster', () => {
    const s = scene();
    const publication = { frame: { lights } } as unknown as PreparedRenderPublication;
    s.source.staged = true;
    s.source.publication = publication;
    beginRenderFrame(s.world, 1);
    expect(s.consume).toHaveBeenCalledWith(publication);
    expect(s.adoption().advance).toBe(advance);
    expect(s.roster()).toBe(lights);
  });

  it('stores an adoption failure instead of poisoning the Render World', () => {
    const s = scene();
    const cause = new Error('composition retired');
    s.consume.mockImplementation(() => {
      throw cause;
    });
    s.source.staged = true;
    s.source.publication = { frame: { lights } } as unknown as PreparedRenderPublication;
    expect(() => beginRenderFrame(s.world, 1)).not.toThrow();
    expect(s.adoption()).toEqual({ advance: undefined, failure: cause });
  });

  it('leaves the frame without an adoption once the system is removed', () => {
    const s = scene();
    s.world.removeSystem(RenderExtract, RENDER_SCENE_SYSTEM).unwrap();
    s.source.staged = true;
    s.source.buildCandidateFrame = () => ({}) as ExtractedFrame;
    beginRenderFrame(s.world, 1);
    expect(s.extract).not.toHaveBeenCalled();
    expect(s.adoption().advance).toBeUndefined();
  });
});

describe('skin-inputs and instance-collections systems', () => {
  const stage = (s: ReturnType<typeof scene>) => {
    s.source.staged = true;
    s.source.buildCandidateFrame = () => ({}) as ExtractedFrame;
  };

  it('are listed in RenderExtract after render-scene', () => {
    const s = scene();
    const extract = s.world.scheduleData().find((schedule) => schedule.name === 'RenderExtract');
    const names = extract?.systems.map((system) => system.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        RENDER_SCENE_SYSTEM,
        SKIN_INPUTS_SYSTEM,
        INSTANCE_COLLECTIONS_SYSTEM,
      ]),
    );
    expect(names.indexOf(SKIN_INPUTS_SYSTEM)).toBeGreaterThan(names.indexOf(RENDER_SCENE_SYSTEM));
    expect(names.indexOf(INSTANCE_COLLECTIONS_SYSTEM)).toBeGreaterThan(
      names.indexOf(SKIN_INPUTS_SYSTEM),
    );
  });

  it('adopt the step once per frame', () => {
    const s = scene();
    stage(s);
    beginRenderFrame(s.world, 1);
    expect(s.adoptSkinInputs).toHaveBeenCalledTimes(1);
    expect(s.adoptInstanceCollections).toHaveBeenCalledTimes(1);
  });

  it('adopt nothing once removed', () => {
    const s = scene();
    s.world.removeSystem(RenderExtract, SKIN_INPUTS_SYSTEM).unwrap();
    s.world.removeSystem(RenderExtract, INSTANCE_COLLECTIONS_SYSTEM).unwrap();
    stage(s);
    beginRenderFrame(s.world, 1);
    expect(s.adoptSkinInputs).not.toHaveBeenCalled();
    expect(s.adoptInstanceCollections).not.toHaveBeenCalled();
  });

  it('discard the queued work of a failed scene step', () => {
    const s = scene();
    s.consume.mockImplementation(() => {
      throw new Error('retired');
    });
    s.source.staged = true;
    s.source.publication = { frame: { lights } } as unknown as PreparedRenderPublication;
    beginRenderFrame(s.world, 1);
    expect(s.adoptSkinInputs).not.toHaveBeenCalled();
    expect(s.discardAdoption).toHaveBeenCalled();
  });

  it('store a Skin adoption failure for every view to rethrow', () => {
    const s = scene();
    const cause = new Error('skin retired');
    s.adoptSkinInputs.mockImplementation(() => {
      throw cause;
    });
    stage(s);
    expect(() => beginRenderFrame(s.world, 1)).not.toThrow();
    expect(s.adoption().failure).toBe(cause);
    expect(s.adoptInstanceCollections).not.toHaveBeenCalled();
  });
});
