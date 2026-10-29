import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  Camera,
  createRenderPublisher,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  renderPublicationTransfers,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render';
import { propagateTransforms, scenePlugin, Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createRenderer } from '../createRenderer';

it.each([
  ['local', 'hide'],
  ['local', 'despawn'],
  ['publication', 'hide'],
  ['publication', 'despawn'],
] as const)(
  'keeps hidden pipeline preparation valid after the last visible mesh %s/%s',
  {
    timeout: 60_000,
  },
  async (mode, change) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 192;
    canvas.style.width = canvas.style.height = '192px';
    document.body.append(canvas);
    const identity = { source: `hidden-preparation-${change}`, epoch: 1 };
    const renderer = (
      await createRenderer(canvas, mode === 'publication' ? { publicationSource: identity } : {}, {
        shaderManifestUrl: '/shaders/manifest.json',
      })
    ).unwrap();
    renderer
      .setProfile({ ...renderer.inspect().profile, renderPath: 'deferred', ssao: false })
      .unwrap();
    const assets = new AssetRegistry();
    const world = new World({ assets });
    const scene = await createWorldContext(world, [scenePlugin()]);
    const errors: unknown[] = [];
    const unsubscribe = renderer.subscribe((event) => {
      if (event.kind === 'error') errors.push(event.error);
    });
    const publisher =
      mode === 'publication'
        ? createRenderPublisher(world, assets, identity, renderer.inspect().capabilities)
        : undefined;
    try {
      const material = assets
        .create(Materials.standard({ baseColor: [0.1, 0.55, 0.9, 1] }))
        .unwrap();
      const box = createBoxGeometry(1, 1, 1).unwrap();
      // Real mesh-default specialization, not a manually injected MaterialFrame.
      const mesh = assets
        .create({
          ...box,
          materialSlots: box.materialSlots.map((slot) => ({ ...slot, defaultMaterial: material })),
        })
        .unwrap();
      const spawnVisible = () =>
        world
          .spawn(
            { component: Transform, data: {} },
            { component: MeshFilter, data: { assetHandle: mesh } },
            { component: MeshRenderer, data: {} },
            { component: Visibility, data: { state: VisibilityStateValue.visible } },
          )
          .unwrap();
      const visible = spawnVisible();
      // Mirrors the game's hidden preparePipelines terrain companion entities.
      world
        .spawn(
          { component: Transform, data: { pos: [2, 0, 0] } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { preparePipelines: true } },
          { component: Visibility, data: { state: VisibilityStateValue.hidden } },
        )
        .unwrap();
      const floorMaterial = assets
        .create(Materials.standard({ baseColor: [0.7, 0.7, 0.7, 1] }))
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, -1.25, 0] } },
          {
            component: MeshFilter,
            data: { assetHandle: assets.create(createBoxGeometry(7, 0.2, 7).unwrap()).unwrap() },
          },
          { component: MeshRenderer, data: { materials: [floorMaterial] } },
        )
        .unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: {
            direction: [-0.5, -0.9, -0.7],
            intensity: 3,
            castShadow: true,
            mapSize: 256,
            cascadeCount: 1,
          },
        })
        .unwrap();
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0.5, 7] } },
          {
            component: Camera,
            data: {
              fov: Math.PI / 4,
              aspect: 1,
              near: 0.1,
              far: 40,
              antialias: ANTIALIAS_NONE,
              bloom: BLOOM_DISABLED,
            },
          },
        )
        .unwrap();
      const lease = publisher === undefined ? renderer.attach(world).unwrap() : undefined;
      let frames = 0;
      const draw = async () => {
        world.update(1 / 60).unwrap();
        propagateTransforms(world).unwrap();
        const candidate = publisher?.prepare(++frames / 60).unwrap();
        const packet =
          candidate === undefined
            ? undefined
            : structuredClone(candidate.message, {
                transfer: renderPublicationTransfers(candidate.message),
              });
        candidate?.accept();
        const request =
          packet !== undefined
            ? { publication: packet }
            : lease === undefined
              ? undefined
              : { leases: [lease], camera: { lease }, environment: { lease } };
        if (request === undefined) throw new Error('missing scene owner');
        const result = renderer.draw(request);
        if (!result.ok) throw new Error(JSON.stringify(result.error), { cause: result.error });
        const drawn = result.value;
        (await drawn.completed).unwrap();
        if (packet !== undefined) {
          const transfer = renderPublicationTransfers(packet);
          publisher?.recycle(packet.revision, structuredClone(transfer, { transfer })).unwrap();
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return drawn;
      };
      const ready = async () => {
        for (let frame = 0; frame < 120; frame++) {
          const receipt = await draw();
          if (receipt.presentation === 'ready') return receipt;
        }
        throw new Error('hidden preparation never reached a ready scene');
      };
      const capture = async () => {
        if (renderer.requestObservation === undefined)
          throw new Error('missing final-display capture');
        renderer.requestObservation(['final-display']).unwrap();
        const receipt = await ready();
        const observed = (await renderer.observe(receipt, { include: ['final-display'] })).unwrap();
        const picture = observed.observations?.find((value) => value.domain === 'final-display');
        if (picture?.domain !== 'final-display') throw new Error('missing scene pixels');
        return picture.bytes.slice();
      };
      const screenshot = (phase: string) =>
        page.elementLocator(canvas).screenshot({
          path: `hidden-preparation-${mode}-${change}-${phase}.png`,
        });
      await ready();
      const before = await capture();
      await screenshot('visible');
      if (change === 'hide')
        world.set(visible, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
      else world.despawn(visible).unwrap();
      const hidden = await capture();
      expect(hidden).not.toEqual(before);
      for (let frame = 0; frame < 60; frame++) expect((await draw()).presentation).toBe('ready');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      await screenshot('hidden-preparing');
      if (change === 'hide')
        world.set(visible, Visibility, { state: VisibilityStateValue.visible }).unwrap();
      else spawnVisible();
      expect(await capture()).not.toEqual(hidden);
      await screenshot('restored');
      expect(errors, JSON.stringify(errors)).toEqual([]);
    } finally {
      unsubscribe();
      publisher?.dispose();
      await renderer.dispose();
      await scene.fiber.dispose();
      assets.dispose();
      canvas.remove();
    }
  },
);
