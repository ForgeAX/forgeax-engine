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
import type { AssetHandle, TextureGeneratorAsset } from '@forgeax/engine-types';

function required<T>(value: T | undefined, expected: string): T {
  if (value === undefined) throw new Error(expected);
  return value;
}

/** A normal material/mesh consumer; residency, mip generation and submission stay with Renderer. */
export function createTextureWorkspacePreview(
  world: World,
  assets: AssetRegistry,
  assetHandle: AssetHandle<'texture' | 'gpu-texture' | 'equirect' | 'texture-generator'>,
  options: Partial<TextureViewOptions> = {},
  generationStatus?: () =>
    | { readonly status: string; readonly error?: { readonly expected: string } }
    | undefined,
) {
  const asset = assets.read(assetHandle).unwrap();
  const generator = asset.kind === 'texture-generator' ? asset : undefined;
  const generatorGuid =
    generator === undefined ? undefined : assets.source(assetHandle).unwrap()?.guid;
  if (generator !== undefined && generatorGuid === undefined)
    throw new Error('Generator preview requires its published asset identity');
  const outputNames = generator === undefined ? [] : Object.keys(generator.outputs);
  const initialOutput = options.output ?? outputNames[0];
  const describeOutput = (name: string) => {
    const content = assets.read(assetHandle).unwrap() as TextureGeneratorAsset;
    const descriptor = content.outputs[name];
    if (descriptor === undefined) throw new Error('Generator preview output is missing');
    return {
      kind: 'gpu-texture',
      ...descriptor,
      source: {
        kind: 'generated',
        generator: required(generatorGuid, 'A published generator identity is required'),
        output: name,
      },
    } as const;
  };
  let info = describeTextureView(
    generator === undefined
      ? (asset as Exclude<typeof asset, TextureGeneratorAsset>)
      : describeOutput(required(initialOutput, 'A declared generator output is required')),
  );
  if (generator !== undefined)
    info = {
      ...info,
      generator: {
        guid: required(generatorGuid, 'A published generator identity is required'),
        outputs: outputNames,
      },
      options: {
        ...info.options,
        output: required(initialOutput, 'A declared generator output is required'),
      },
    };
  info = { ...info, options: validateTextureViewOptions(info, options) };
  let material = createTextureViewMaterial(info.dimension);
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
    const outputHandles = new Map<string, AssetHandle<'gpu-texture'>>();
    const outputHandle = (name: string) => {
      let handle = outputHandles.get(name);
      if (handle === undefined) {
        handle = assets.create(describeOutput(name)).unwrap();
        outputHandles.set(name, handle);
        const owned = handle;
        disposers.push(() => assets.release(owned).unwrap());
      }
      return handle;
    };
    let textureHandle =
      generator !== undefined
        ? outputHandle(required(initialOutput, 'A declared generator output is required'))
        : asset.kind !== 'equirect'
          ? (assetHandle as AssetHandle<'texture' | 'gpu-texture'>)
          : assets
              .create(textureViewSource(asset as Exclude<typeof asset, TextureGeneratorAsset>))
              .unwrap();
    if (generator === undefined && textureHandle !== assetHandle)
      disposers.push(() => assets.release(textureHandle).unwrap());
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
        ['flat', 'environment', 'cross', 'face', 'atlas', 'volume'].indexOf(options.projection),
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
    const refreshInfo = () => {
      if (generator === undefined) return;
      const latest = assets.read(assetHandle).unwrap() as TextureGeneratorAsset;
      const description = describeTextureView(assets.read(textureHandle).unwrap());
      const next = {
        ...description,
        generator: {
          guid: required(generatorGuid, 'A published generator identity is required'),
          outputs: Object.keys(latest.outputs),
        },
        options: info.options,
      };
      let options: TextureViewOptions;
      try {
        options = validateTextureViewOptions(next, info.options);
      } catch {
        options = validateTextureViewOptions(next, { ...info.options, mip: 0, layer: 0 });
      }
      if (description.dimension !== info.dimension) {
        const previous = material;
        material = createTextureViewMaterial(description.dimension);
        try {
          assets.replace(materialHandle, { ...material, values: values(options) }).unwrap();
        } catch (cause) {
          material = previous;
          throw cause;
        }
      } else if (options.mip !== info.options.mip || options.layer !== info.options.layer) {
        assets.update(materialHandle, { values: values(options) }).unwrap();
      }
      info = { ...next, options };
    };
    const texture: TextureViewControl = {
      get() {
        assertOpen();
        refreshInfo();
        const status = generationStatus?.();
        if (info.generator !== undefined && status !== undefined)
          info = {
            ...info,
            generator: {
              guid: info.generator.guid,
              outputs: info.generator.outputs,
              status: status.status,
              ...(status.error === undefined ? {} : { error: status.error.expected }),
            },
          };
        return structuredClone(info);
      },
      set(patch) {
        assertOpen();
        refreshInfo();
        const options = validateTextureViewOptions(info, patch);
        if (generator !== undefined && options.output !== info.options.output) {
          const nextHandle = outputHandle(
            required(options.output, 'A selected generator output is required'),
          );
          const next = describeTextureView(assets.read(nextHandle).unwrap());
          const nextInfo = {
            ...next,
            generator: required(info.generator, 'A generator preview is required'),
            options: { ...options, mip: 0, layer: 0 },
          };
          const previousHandle = textureHandle;
          const previousMaterial = material;
          textureHandle = nextHandle;
          material = createTextureViewMaterial(next.dimension);
          try {
            assets
              .replace(materialHandle, { ...material, values: values(nextInfo.options) })
              .unwrap();
          } catch (cause) {
            textureHandle = previousHandle;
            material = previousMaterial;
            throw cause;
          }
          info = nextInfo;
        } else {
          assets.update(materialHandle, { values: values(options) }).unwrap();
          info = { ...info, options };
        }
        return structuredClone(info);
      },
    };
    return {
      texture,
      refreshContent() {
        assertOpen();
        const current = assets.read(assetHandle).unwrap();
        if (current.kind === 'texture-generator') {
          assets
            .replace(
              textureHandle,
              describeOutput(
                required(info.options.output, 'A selected generator output is required'),
              ),
            )
            .unwrap();
          refreshInfo();
          return;
        }
        const next = describeTextureView(current);
        let adopted: TextureViewOptions;
        try {
          adopted = validateTextureViewOptions(next, info.options);
        } catch {
          adopted = validateTextureViewOptions(next, {
            channels: info.options.channels,
            exposure: info.options.exposure,
          });
        }
        info = { ...next, options: adopted };
        material = createTextureViewMaterial(info.dimension);
        if (textureHandle !== assetHandle)
          assets.replace(textureHandle, textureViewSource(current)).unwrap();
        assets.replace(materialHandle, { ...material, values: values(adopted) }).unwrap();
      },
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
