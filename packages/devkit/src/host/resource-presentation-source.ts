export const previewVfxBoundsSource = `function previewVfxBounds(payload) {
  if (payload?.kind !== 'particle-effect' || payload.program?.emitters?.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const emitter of payload.program.emitters) {
    const bounds = emitter.bounds;
    if (bounds?.kind === 'sphere' && Array.isArray(bounds.center) && typeof bounds.radius === 'number') {
      const [x, y, z] = bounds.center;
      if (![x, y, z, bounds.radius].every((value) => typeof value === 'number' && Number.isFinite(value)) || bounds.radius < 0) return undefined;
      minX = Math.min(minX, x - bounds.radius);
      minY = Math.min(minY, y - bounds.radius);
      minZ = Math.min(minZ, z - bounds.radius);
      maxX = Math.max(maxX, x + bounds.radius);
      maxY = Math.max(maxY, y + bounds.radius);
      maxZ = Math.max(maxZ, z + bounds.radius);
      continue;
    }
    if (bounds?.kind === 'aabb' && Array.isArray(bounds.min) && Array.isArray(bounds.max)) {
      const [loX, loY, loZ] = bounds.min;
      const [hiX, hiY, hiZ] = bounds.max;
      if (![loX, loY, loZ, hiX, hiY, hiZ].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
      minX = Math.min(minX, loX);
      minY = Math.min(minY, loY);
      minZ = Math.min(minZ, loZ);
      maxX = Math.max(maxX, hiX);
      maxY = Math.max(maxY, hiY);
      maxZ = Math.max(maxZ, hiZ);
      continue;
    }
    return undefined;
  }
  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) return undefined;
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(1, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ));
  return { aabb: [minX, minY, minZ, maxX, maxY, maxZ], center, radius };
}
`;

export const resourcePresentationSource = `async function prepareResourcePreview(app, resource, previewCanvas = canvas, presentation = {}) {
const resourceVfx = previewVfxHosts.get(app) ?? (resource?.kind === 'vfx' ? ensureVfxRuntimeHost() : undefined);
let preparedResourceBinding;
await prepareAssetRegistry(app.assets);
const assets = app.assets;
const ownedEntities = [];
const ownedHandles = [];
const allocOwned = (target, payload) => {
  const handle = app.world.allocSharedRef(target, payload);
  ownedHandles.push(handle);
  return handle;
};
const internOwned = (target, payload) => {
  const handle = app.world.internSharedRef(target, payload);
  ownedHandles.push(handle);
  return handle;
};
const spawnOwned = (...components) => {
  const spawned = app.world.spawn(...components);
  if (!spawned.ok) throw spawned.error;
  ownedEntities.push(spawned.value);
  return spawned.value;
};
let resourceVfxAttached = false;
let canonicalEnvironment;
let closed = false;
let cleanupPromise;
const cleanup = async () => {
  if (cleanupPromise !== undefined) return cleanupPromise;
  closed = true;
  cleanupPromise = (async () => {
    let failure;
    previewCameraEntities.delete(app.world);
    previewCameraTargets.delete(app.world);
    for (let index = ownedEntities.length - 1; index >= 0; index -= 1) {
      const dropped = app.world.despawn(ownedEntities[index]);
      if (!dropped.ok && dropped.error?.code !== 'stale-entity' && failure === undefined) {
        failure = dropped.error;
      }
    }
    if (resourceVfxAttached) {
      const detached = await resourceVfx.detachWorld({ world: app.world });
      if (!detached.ok && failure === undefined) failure = detached.error;
    }
    for (const handle of ownedHandles.splice(0).reverse()) {
      const released = app.world.sharedRefs.release(handle);
      if (!released.ok && released.error?.code !== 'shared-ref-released' && failure === undefined) {
        failure = released.error;
      }
    }
    preparedResourceBinding = undefined;
    if (failure !== undefined) throw failure;
  })();
  return cleanupPromise;
};
try {
if (resource !== undefined) {
  if (resource.kind === 'texture' || resource.kind === 'equirect') {
    const loaded = await assets.loadByGuid(assets.parseGuid(resource.guid));
    if (!loaded.ok) throw loaded.error;
    const payload = loaded.value;
    if (payload.kind !== 'texture' && payload.kind !== 'equirect') throw new Error('Texture preview requires TextureAsset or EquirectAsset');
    const source = textureViewSource(payload);
    const ownerFacts = presentation.evidence === false ? undefined : await previewOwnerFacts(assets, { ...resource, kind: 'texture' }, source);
    const assetBinding = captureEngineWorkspaceAssetBinding(assets, resource.guid, payload);
    const owner = createTextureWorkspacePreview(app.world, payload,
      presentation.background === 'transparent' ? { background: presentation.background, projection: 'flat' } : {});
    previewCameraEntities.set(app.world, owner.camera);
    previewCameraTargets.set(app.world, [0, 0, 0]);
    return {
      app, texture: owner.texture,
      get binding() { return owner.binding; },
      assetBinding,
      facts: { kind: resource.kind, guid: resource.guid, asset: payload, ...(ownerFacts === undefined ? {} : { ownerFacts }) },
      close: async () => { try { owner.close(); } finally { await cleanup(); } },
    };
  }
  if (presentation.lighting !== 'neutral') {
    if (canonicalEnvironmentGuid === null) throw new Error('canonical preview environment is unavailable');
    const environment = await assets.loadByGuid(assets.parseGuid(canonicalEnvironmentGuid));
    if (!environment.ok) throw environment.error;
    if (environment.value.kind !== 'equirect') {
      throw new Error(\`canonical preview environment expected equirect, received \${environment.value.kind}\`);
    }
    if (environment.value.width <= 0 || environment.value.height <= 0 || environment.value.data.byteLength === 0) {
      throw new Error('canonical preview environment must provide decoded equirect pixels');
    }
    canonicalEnvironment = allocOwned('EquirectAsset', environment.value);
  }
  if (resource.kind === 'vfx') {
    const runtime = resourceVfx;
    const attached = await runtime.attachWorld({ world: app.world, assets });
    if (!attached.ok) throw attached.error;
    resourceVfxAttached = attached.value.state === 'attached';
  }
  const loaded = await assets.loadByGuid(assets.parseGuid(resource.guid));
  if (!loaded.ok) throw loaded.error;
  const payload = loaded.value;
  const assetBinding = captureEngineWorkspaceAssetBinding(assets, resource.guid, payload);
  if (resource.kind === 'vfx' && payload.kind !== 'particle-effect') {
    throw new Error(\`VFX preview expected ParticleEffectAsset, received \${payload.kind}\`);
  }
  const vfxBounds = resource.kind === 'vfx' ? previewVfxBounds(payload) : undefined;
  if (resource.kind === 'vfx' && vfxBounds === undefined) {
    throw new Error('VFX preview owner did not publish finite emitter bounds');
  }
  const meshMaterialHandles = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? await loadEngineWorkspaceMaterialSlots(
        payload.materialSlots,
        async (slot) => {
          const material = await assets.loadByGuid(
            assets.parseGuid(AssetGuid.format(slot.defaultMaterial)),
          );
          if (!material.ok) return material;
          if (material.value.kind !== 'material') {
            throw new Error('mesh material slot resolved to a non-material asset');
          }
          return material;
        },
        (material) => allocOwned('MaterialAsset', material),
      )
    : undefined;
  const meshHandle = resource.kind === 'mesh' && payload.kind === 'mesh'
    ? allocOwned('MeshAsset', payload)
    : internOwned(
        'MeshAsset',
        createPrimitiveMesh('sphere').unwrap(),
      );
  const materialPayload = resource.kind === 'material' && payload.kind === 'material' ? payload : undefined;
  const materialHandle = materialPayload === undefined
    ? undefined
    : allocOwned('MaterialAsset', materialPayload);
  const materialBindings = resource.kind === 'mesh'
    ? meshMaterialHandles
    : materialHandle === undefined
      ? undefined
      : [materialHandle];
  const rawAabb = payload.kind === 'mesh' ? payload.aabb : undefined;
  const aabb = rawAabb !== undefined && (Array.isArray(rawAabb) || ArrayBuffer.isView(rawAabb)) && rawAabb.length === 6
    ? Array.from(rawAabb)
    : resource.kind === 'mesh' && payload.kind === 'mesh'
      ? (() => { throw new Error('mesh owner did not publish a finite AABB'); })()
      : [-1, -1, -1, 1, 1, 1];
  const meshFrame = resource.kind === 'mesh' || resource.kind === 'material'
    ? fitToolPreviewCameraToAabb(aabb, { aspect: 1, fov: Math.PI / 4 })
    : undefined;
  const center = meshFrame?.center ?? vfxBounds?.center ?? [(aabb[0] + aabb[3]) / 2, (aabb[1] + aabb[4]) / 2, (aabb[2] + aabb[5]) / 2];
  const radius = meshFrame?.radius ?? vfxBounds?.radius ?? Math.max(1, Math.hypot(aabb[3] - aabb[0], aabb[4] - aabb[1], aabb[5] - aabb[2]));
  if (resource.kind === 'vfx') {
    const effect = allocOwned('ParticleEffectAsset', payload);
    spawnOwned(
      { component: Transform, data: { pos: center } },
      { component: ParticleEffectPlayer, data: { effect, playing: true, seed: 0, timeScale: 1 } },
    );
  } else {
    const previewMeshEntity = spawnOwned(
      { component: Transform, data: { pos: center } },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: materialBindings === undefined ? {} : { materials: materialBindings } },
    );
    preparedResourceBinding = {
      entityKey: previewMeshEntity,
      worldIdentity: app.world.identity,
      materialHandle,
    };
  }
  const cameraData = {
        fov: Math.PI / 4,
        aspect: 1,
        near: meshFrame?.near ?? 0.01,
        far: meshFrame?.far ?? radius * 8,
        tonemap: TONEMAP_REINHARD_EXTENDED,
        ...(presentation.background === 'transparent' ? { clearColor: [0, 0, 0, 0] } : {}),
        ...(presentation.antialias === undefined ? {} : { antialias: presentation.antialias }),
        ...(presentation.bloom === undefined ? {} : { bloom: presentation.bloom }),
      };
  const cameraPosition = [center[0], center[1], center[2] + (meshFrame?.distance ?? radius * 2.5)];
  const cameraEntity = spawnOwned({ component: Camera, data: cameraData }, { component: Transform, data: { pos: cameraPosition } });
  previewCameraEntities.set(app.world, cameraEntity);
  previewCameraTargets.set(app.world, center);
  {
    spawnOwned({ component: DirectionalLight, data: { direction: [-0.5, -1, -0.3], intensity: 2 } });
    if (presentation.lighting === 'neutral') {
      spawnOwned({ component: Skylight, data: { color: [1, 1, 1], intensity: 1 } });
    } else {
      if (canonicalEnvironment === undefined) throw new Error('canonical preview environment was not loaded');
      spawnOwned({ component: Skylight, data: { equirect: canonicalEnvironment } });
      if (presentation.background !== 'transparent')
        spawnOwned({ component: SkyboxBackground, data: { equirect: canonicalEnvironment } });
    }
  }
  const textureBudget = resource.kind === 'material' && materialHandle !== undefined
    ? materialSampledTextureBudget(app.world, assets, materialHandle)
    : undefined;
  const ownerFacts = presentation.evidence === false ? undefined : await previewOwnerFacts(assets, resource, payload, textureBudget);
  const publishedAsset = resource.kind === 'mesh' && payload.kind === 'mesh' && payload.aabb !== undefined
    ? { ...payload, aabb: Array.from(payload.aabb) }
    : payload;
  return {
    facts: {
      kind: resource.kind,
      guid: resource.guid,
      asset: publishedAsset,
      ...(ownerFacts === undefined ? {} : { ownerFacts }),
    },
    app,
    binding: preparedResourceBinding,
    assetBinding,
    close: cleanup,
  };
}
} catch (cause) {
  await cleanup();
  throw cause;
}
}
`;
