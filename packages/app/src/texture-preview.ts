import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import {
  createTextureViewMaterial,
  describeTextureView,
  type TextureViewControl,
  type TextureViewOptions,
  textureViewSource,
  validateTextureViewOptions,
} from '@forgeax/engine-preview';
import { Camera, MeshFilter, MeshRenderer, TONEMAP_NONE } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { AssetHandle } from '@forgeax/engine-types';

/** A normal material/mesh consumer; residency, mip generation and submission stay with Renderer. */
export function createTextureWorkspacePreview(
  world: World,
  assets: AssetRegistry,
  assetHandle: AssetHandle<'texture' | 'equirect'>,
  options: Partial<TextureViewOptions> = {},
) {
  const asset = assets.read(assetHandle).unwrap();
  let info = describeTextureView(asset);
  info = { ...info, options: validateTextureViewOptions(info, options) };
  const material = createTextureViewMaterial(info.dimension);
  let closed = false;
  const disposers: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Texture preview cleanup failed');
  };
  try {
    assets.retain(assetHandle).unwrap();
    disposers.push(() => assets.release(assetHandle).unwrap());
    const textureHandle =
      asset.kind === 'texture'
        ? (assetHandle as AssetHandle<'texture'>)
        : assets.create(textureViewSource(asset)).unwrap();
    if (textureHandle !== assetHandle) disposers.push(() => assets.release(textureHandle).unwrap());
    const meshHandle = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    disposers.push(() => assets.release(meshHandle).unwrap());
    const values = (options: TextureViewOptions) => ({
      ...material.values,
      sourceTexture: textureHandle,
      channels: options.channels.map(Number),
      display: [
        options.mip,
        options.layer,
        Number(options.filter === 'linear'),
        2 ** options.exposure,
      ],
      presentation: [
        ['flat', 'environment', 'cross', 'face'].indexOf(options.projection),
        options.face,
        options.zoom === 'fit' ? 0 : options.zoom,
        Number(options.desaturate),
      ],
      panRotation: [...options.pan, ...options.rotation.map((v) => (v * Math.PI) / 180)],
      background: [
        ['checker', 'black', 'white', 'transparent'].indexOf(options.background),
        Number(info.kind === 'equirect'),
        0,
        0,
      ],
    });
    const materialHandle = assets
      .create({
        ...material,
        values: values(info.options),
      })
      .unwrap();
    disposers.push(() => assets.release(materialHandle).unwrap());
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [materialHandle] } },
      )
      .unwrap();
    disposers.push(() => world.despawn(entity).unwrap());
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            near: 0.01,
            far: 100,
            tonemap: TONEMAP_NONE,
            antialias: 0,
            bloom: 0,
            clearColor: [0, 0, 0, 0],
          },
        },
      )
      .unwrap();
    disposers.push(() => world.despawn(camera).unwrap());
    const assertOpen = () => {
      if (closed) throw new Error('Texture preview has been disposed');
    };
    const texture: TextureViewControl = {
      get() {
        assertOpen();
        return structuredClone(info);
      },
      set(patch) {
        assertOpen();
        const options = validateTextureViewOptions(info, patch);
        assets.update(materialHandle, { values: values(options) }).unwrap();
        info = { ...info, options };
        return structuredClone(info);
      },
    };
    return {
      texture,
      camera,
      get binding() {
        return { entityKey: entity, worldIdentity: world.identity, materialHandle, textureHandle };
      },
      close,
    };
  } catch (cause) {
    try {
      close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], 'Texture preview setup failed');
    }
    throw cause;
  }
}
