import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { renderLifecycleManifestUrl } from '../../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../../../components';
import { Outline } from '../../../components/outline';
import { editorAssistance } from '../state';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

it('keeps author outlines intact, admits editor passes and retires them when disabled', async () => {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    value(await renderer.initialization);
    const world = new World({ assets: renderer.assetRegistry });
    registerPropagateTransforms(world);
    const mesh = renderer.assetRegistry.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    const cube = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
      )
      .unwrap();
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 100 } },
        { component: Outline, data: { entities: [cube], width: 2, visibleColor: [0, 0, 1] } },
      )
      .unwrap();
    const lease = value(renderer.attach(world));
    const author = world.get(camera, Outline).unwrap();
    const assistance = editorAssistance(world);
    assistance.configure({ enabled: true, camera }).unwrap();
    assistance.select([cube]).unwrap();
    assistance
      .contribute({}, [
        {
          kind: 'line',
          start: [-1, 0, 0],
          end: [1, 0, 0],
          color: [1, 0, 0, 1],
          depth: 'always',
          action: { kind: 'entity', entity: cube },
        },
      ])
      .unwrap();
    world.update(1 / 60).unwrap();
    let lastReceipt: import('../../../render-contract').FrameReceipt | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = renderer.draw({ source: lease });
      if (result.ok && result.value !== undefined) lastReceipt = result.value;
      if (!result.ok && attempt === 7) throw new Error(JSON.stringify(errors));
      if (
        lastReceipt?.presentation === 'ready' &&
        renderer.perFramePassNames.some((name) => name.endsWith('editor-always'))
      )
        break;
      if (result.ok && result.value?.preparationCompleted !== undefined)
        value(await result.value.preparationCompleted);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(
      lastReceipt?.editorAssistance,
      JSON.stringify({
        presentation: lastReceipt?.presentation,
        reason: lastReceipt?.presentationPendingReason,
        passes: renderer.perFramePassNames,
        errors,
      }),
    ).toMatchObject({
      frameId: lastReceipt?.frameId,
      deviceGeneration: lastReceipt?.deviceGeneration,
      sourceIdentity: world.identity,
    });
    expect(lastReceipt?.editorAssistance?.views[0]?.hits.length).toBeGreaterThan(0);
    expect(renderer.perFramePassNames, JSON.stringify(errors)).toContain(
      'editor-outline-selection',
    );
    expect(renderer.perFramePassNames.some((name) => name.endsWith('editor-always'))).toBe(true);
    expect(renderer.perFramePassNames).not.toContain('outline-selection');
    expect(world.get(camera, Outline).unwrap()).toEqual(author);
    expect([...world.query({ with: [Transform] }).unwrap()].length).toBe(2);
    assistance.clear();
    value(renderer.draw({ source: lease }));
    expect(renderer.perFramePassNames.some((name) => name.includes('editor-'))).toBe(false);
    expect(world.get(camera, Outline).unwrap()).toEqual(author);
    expect(renderer.perFramePassNames).toContain('outline-selection');
  } finally {
    await renderer.dispose();
  }
});
