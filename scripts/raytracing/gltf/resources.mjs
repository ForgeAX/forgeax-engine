import {
  getOrCreateMipmapPipeline,
  numMipLevels,
  prepareMipmaps,
} from '../../../packages/assets-runtime/dist/index.mjs';
/** Original imported textures, mip chains and scene snapshot shared by reference carriers. */
export async function createGltfResources(device, compile, prepared, load, progress = () => {}) {
  const owned = [];
  const graphTextures = [];
  const dispose = () => {
    for (const texture of owned) device.destroyTexture(texture);
    owned.length = 0;
  };
  try {
    const scene = {
      ...prepared.scene,
      instanceAttributes: new Map(prepared.scene.instanceAttributes),
    };
    for (const key of ['triangles', 'nodes', 'attributes']) scene[key] = await load(`${key}.bin`);
    const textures = new Map(),
      samplers = new Map();
    const address = (v) =>
      v === 33071 ? 'clamp-to-edge' : v === 33648 ? 'mirror-repeat' : 'repeat';
    for (const [id, s] of (prepared.samplers ?? []).entries())
      samplers.set(
        id,
        device
          .createSampler({
            addressModeU: address(s.wrapS),
            addressModeV: address(s.wrapT),
            magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
            minFilter: [9728, 9984, 9986].includes(s.minFilter) ? 'nearest' : 'linear',
            mipmapFilter: [9984, 9985].includes(s.minFilter) ? 'nearest' : 'linear',
          })
          .unwrap(),
      );
    const defaultSampler = device
      .createSampler({
        addressModeU: 'repeat',
        addressModeV: 'repeat',
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'linear',
      })
      .unwrap();
    progress('Uploading original textures and building mip chains');
    for (const image of prepared.images) {
      const format = image.colorSpace === 'srgb' ? 'rgba8unorm-srgb' : 'rgba8unorm';
      const levels = numMipLevels(image);
      const texture = device
        .createTexture({
          label: `gltf.image-${image.id}`,
          size: { width: image.width, height: image.height },
          format,
          usage: 23,
          mipLevelCount: levels,
        })
        .unwrap();
      owned.push(texture);
      device.queue
        .writeTexture(
          { texture },
          await load(`image-${image.id}.bin`),
          { bytesPerRow: image.width * 4 },
          { width: image.width, height: image.height },
        )
        .unwrap();
      (await getOrCreateMipmapPipeline(device, format, compile)).unwrap();
      const work = prepareMipmaps(device, texture, { ...image, format, levels })
        .unwrap()
        .finish()
        .unwrap();
      if (work) device.queue.submit([work]).unwrap();
      const view = device.createTextureView(texture, {}).unwrap();
      textures.set(image.id, view);
      graphTextures.push({
        texture,
        view,
        label: `gltf.image-${image.id}`,
        descriptor: {
          size: { width: image.width, height: image.height },
          format,
          usage: 23,
          mipLevelCount: levels,
        },
      });
    }
    const resolveTexture = (value) => {
      const view = textures.get(value.texture);
      if (!view) throw new Error(`Missing original texture ${value.texture}`);
      return { ok: true, value: { view, sampler: samplers.get(value.sampler) ?? defaultSampler } };
    };
    return {
      scene,
      resolveTexture,
      dispose,
      importTextures(graph) {
        return new Map(
          graphTextures.map(({ texture, view, label, descriptor }) => {
            const imported = graph.importTexture(label, descriptor, () => texture).unwrap();
            return [view, graph.importView(imported, {}, () => view).unwrap()];
          }),
        );
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
