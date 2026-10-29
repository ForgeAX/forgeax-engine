import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { AnimatedBy, AnimationPlayer, AnimationRootMotion, AnimationTargetId, AnimationTargets } from '@forgeax/engine/animation';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, SceneInstance, Visibility } from '@forgeax/engine-render';
import { ChildOf, Children, GlobalTransform, MorphWeights, Name, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { createVfxRuntimeHost } from '@forgeax/engine/vfx-render';
import { hash, unwrap } from './workload.mjs';

// Same assembly options as DevKit's game-vfx-source, without a second camera owner.
export const frontlineVfx = () => createVfxRuntimeHost({ instanceArenas: true, nativePlanning: true, retainedResources: true, isolateViewGraph: true,
  camera: { read: (_world, views) => views[0]?.selectedView } });

export async function createFrontlineWorkload(assets, config) {
  assert(config.gameRoot && config.gameDist, 'frontline requires --game-root and --game-dist');
  const root = resolve(config.gameRoot), dist = resolve(config.gameDist);
  const gameUrl = pathToFileURL(root + sep).href;
  const imported = new Set();
  // Load the real Game's pure producers/controllers against THIS Engine build.
  // Never borrow its unrelated local Engine pin or duplicate ECS component tokens.
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.startsWith(gameUrl) && specifier.startsWith('@forgeax/engine/')) return { url: import.meta.resolve(specifier), shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith(gameUrl)) {
        imported.add(url);
        // Game sources use bundler JSON imports. Preserve the native JSON
        // decoder when running those same sources directly under Node.
        if (url.endsWith('.json')) return next(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
      }
      return next(url, context);
    },
  });
  const gameImport = name => import(pathToFileURL(resolve(root, name)).href);
  const catalogBytes = await readFile(resolve(dist, 'pack-index.json'));
  const catalog = JSON.parse(catalogBytes);
  const rows = catalog.entries.entries;
  assert(Array.isArray(rows), 'normal Game publication catalog required');
  const loaded = new Map();
  assets.setCatalogSource(createCatalogSource({ url: 'https://frontline-fixture.invalid/pack-index.json', fetch: async resource => {
    const name = new URL(resource).pathname.slice(1), path = resolve(dist, name);
    assert(path.startsWith(dist + sep), 'asset outside frozen publication');
    const bytes = await readFile(path); loaded.set(name, { bytes: bytes.length, sha256: hash(bytes) });
    return new Response(bytes);
  } }));
  const mapFile = resolve(root, 'assets/maps/dust2-reconstructed-data.ts');
  const placementFile = resolve(root, 'assets/maps/dust2-reconstructed-placement.ts');
  const { default: map } = await import(pathToFileURL(mapFile).href);
  const { placePoint } = await import(pathToFileURL(placementFile).href);
  const { dust2SurfaceMembers } = await gameImport('assets/maps/dust2-reconstructed-resources/surface-families.generated.ts');
  const { dust2ReconstructedGroundMaterials } = await gameImport('assets/maps/dust2-reconstructed-ground.ts');
  const { authoredSurfaceMesh } = await gameImport('assets/gameplay/authored-surface-mesh.ts');
  const { loadGunshotAssets, createGunshotFx } = await gameImport('assets/gameplay/gunshot-fx.ts');
  const ground = dust2ReconstructedGroundMaterials(map.parts);
  const lookup = new Map(rows.filter(row => row.sourceKey).map(row => [row.kind + ':' + row.sourceKey, row]));
  const parts = [];
  for (let i = 0; i < 16; i++) {
    const part = map.parts[Math.floor(i * map.parts.length / 16)];
    const meshRow = lookup.get('mesh:mesh/' + part.mesh);
    assert(meshRow, 'missing authored Dust2 mesh');
    const mesh = unwrap(await assets.load(meshRow.guid, 'mesh'));
    const materials = [], batches = new Map();
    for (const guid of part.materials) {
      const member = ground.has(guid) ? undefined : dust2SurfaceMembers[guid];
      const row = lookup.get(member ? 'material:surface/' + member.family : 'material:material/' + guid);
      assert(row, 'missing authored Dust2 material ' + guid);
      materials.push(unwrap(await assets.load(row.guid, 'material')));
      if (member) batches.set('workshop:' + guid, { ...member, key: 'workshop:surface/' + member.family });
    }
    const projected = authoredSurfaceMesh(unwrap(assets.read(mesh)), materials, part.materials.map(guid => 'workshop:' + guid), batches);
    parts.push({ part, mesh: unwrap(assets.create(projected.mesh)), materials: projected.materials, guid: meshRow.guid, position: placePoint(part.position) });
  }
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const vocabulary = [Transform, ChildOf, Children, GlobalTransform, MorphWeights, Name, SceneInstance, Skin, Visibility, MeshFilter, MeshRenderer,
    AnimatedBy, AnimationPlayer, AnimationRootMotion, AnimationTargetId, AnimationTargets].map(component => unwrap(world.components.register(component)));
  const vfx = frontlineVfx(); unwrap(await vfx.attachWorld({ world, assets }));
  const shotAssets = await loadGunshotAssets(world, assets, () => false);
  const gunshots = createGunshotFx(world, shotAssets);
  const entities = [], editable = new Map(), fragmentEntities = [];
  const categories = { terrain: config.count, fragments: 32, actors: 2, tracerOwners: 1, cookedEffects: 2 };
  // Keep the same prefix and camera profile at every N. Added tiles are
  // unrelated background, not a reason to change existing positions/range.
  const tileColumns = 256;
  const position = index => {
    const p = parts[index % parts.length].position, tile = Math.floor(index / parts.length);
    return [p[0] + (tile % tileColumns) * 192, p[1], p[2] + Math.floor(tile / tileColumns) * 192];
  };
  for (let index = 0; index < config.count; index++) {
    const part = parts[index % parts.length];
    const mesh = index < config.dirty ? unwrap(assets.copy(part.mesh)) : part.mesh;
    if (index < config.dirty) editable.set(index, mesh);
    entities.push(unwrap(world.spawn({ component: Transform, data: { pos: position(index), quat: part.part.rotation, scale: part.part.scale } },
      { component: MeshFilter, data: { assetHandle: mesh } }, { component: MeshRenderer, data: { materials: part.materials } })));
  }
  const fragment = index => unwrap(world.spawn({ component: Transform, data: { pos: [20 + index % 8 * 0.2, 4, 110 + Math.floor(index / 8) * 0.2], scale: [0.05, 0.05, 0.05] } },
    { component: MeshFilter, data: { assetHandle: parts[index % parts.length].mesh } },
    { component: MeshRenderer, data: { materials: parts[index % parts.length].materials } }));
  for (let index = 0; index < 32; index++) fragmentEntities.push(fragment(index));
  const character = unwrap(await assets.load('01a13984-133c-7565-9335-ba63817d0866', 'scene'));
  const actors = Array.from({ length: 2 }, (_, index) => {
    const anchor = unwrap(assets.instantiate(character, world));
    unwrap(world.set(anchor, Transform, { pos: [15 + index * 2, 3.7, 110] }));
    return anchor;
  });
  const camera = unwrap(world.spawn({ component: Transform, data: { pos: [70, 32, 220], quat: [-0.1, 0, 0, Math.sqrt(0.99)] } },
    { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.08, far: 2000 } }));
  unwrap(world.spawn({ component: DirectionalLight, data: { intensity: 2.1, direction: [0.25, -0.7, -1], castShadow: true, cascadeCount: 4, mapSize: 256 } }));
  const shooters = [{ cooldown: 0, ammo: 30, reload: 0 }, { cooldown: 0.05, ammo: 30, reload: 0 }];
  let elapsed = 0, sequence = 0;
  const events = { shots: 0, reloadStarts: 0, reloadCompletions: 0, meshReplacements: 0, rangePatches: 0, fragmentRetirements: 0 };
  const renderCount = () => { let count = 0; for (const _row of unwrap(world.query({ with: [MeshFilter, MeshRenderer] }))) count++; return count; };
  const provenance = { game: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    voxel: execFileSync('git', ['rev-parse', 'HEAD:vendor/forgeax-voxel'], { cwd: root, encoding: 'utf8' }).trim(),
    catalogSha256: hash(catalogBytes), publicationSha256: hash(await readFile(resolve(dist, 'forgeax-dist.json'))),
    mapRevision: map.revision, mapSourceSha256: hash(await readFile(mapFile)), placementSourceSha256: hash(await readFile(placementFile)),
    gameSources: Object.fromEntries(await Promise.all([...imported].map(async url => [url.slice(gameUrl.length), hash(await readFile(new URL(url)))]))),
    parts: parts.map(row => ({ key: row.part.key, guid: row.guid })), chunkPolicy: config.chunkPolicy,
    scope: 'Actual cooked Dust2 meshes/materials, character Scenes and gunshot effects; controlled render-input timeline, not Game AI/physics/meshing or whole-match FPS. Background geometry repeats 16 authored parts to scale unrelated N. Fragment retirements are admitted source events; physics/support guard evaluation is excluded.' };
  return {
    world, entities, categories, features: [vfx.feature], expectedProjectionRecords: renderCount(), provenance,
    beginMeasurement: () => gunshots.finishPreparation(),
    validate() {
      const snapshot = gunshots.snapshot();
      assert(events.shots > 0, 'gunfire was not exercised');
      assert.equal(snapshot.flashes, events.shots);
      assert.equal(snapshot.tracers, events.shots);
      assert.equal(snapshot.impacts, Math.floor(events.shots / 3));
      assert.equal(events.meshReplacements + events.rangePatches, events.shots);
      assert.equal(snapshot.dropped, 0, 'bounded two-shooter workload dropped visuals');
      assert(snapshot.peak <= snapshot.limits.total && snapshot.pooled <= snapshot.limits.total + 1);
      for (const player of vfx.inspect(world).players) {
        assert.equal(player.queuedTicks, 0, 'receiver feedback did not drain VFX ticks');
        assert.equal(player.queuedIntents, 0);
        assert.equal(player.diagnostics.length, 0);
      }
      if (config.frames >= 600) {
        assert(events.reloadCompletions >= 2 && events.fragmentRetirements > 0, 'long lifecycle window was not exercised');
      }
      if (config.frames === 600) assert.equal(snapshot.active, 0, 'final reload must allow finite effects to retire');
    },
    metrics: () => ({ events, gunshots: gunshots.snapshot(),
      renderables: renderCount(), vfx: vfx.inspect(world), fetched: Object.fromEntries(loaded) }),
    async dispose() { gunshots.dispose(); unwrap(await vfx.detachWorld({ world })); for (const lease of vocabulary) lease.dispose(); hooks.deregister(); },
    apply(_phase, tick, { measured = true } = {}) {
      if (!measured) return { tick, preparation: true };
      const dt = 1 / 60; elapsed += dt;
      const operation = { tick, shots: [], damage: [], retiredEffects: 0, retiredFragments: 0 };
      gunshots.update(dt, 'ar', 'local', false);
      for (const [index, shooter] of shooters.entries()) {
        shooter.cooldown = Math.max(0, shooter.cooldown - dt);
        if (shooter.reload > 0) { shooter.reload -= dt; if (shooter.reload <= 0) { shooter.ammo = 30; shooter.cooldown = Math.max(shooter.cooldown, 0.12); events.reloadCompletions++; } continue; }
        if (shooter.cooldown > 0) continue;
        if (shooter.ammo === 0) { shooter.reload = 1.65; events.reloadStarts++; continue; }
        shooter.ammo--; shooter.cooldown = 0.1; sequence++; events.shots++; operation.shots.push(index);
        const pos = [15 + index * 2, 5, 110], target = [20, 4, 90], direction = [0, 0, -1];
        gunshots.muzzle({ weaponId: 'ar', origin: pos, rays: [{ direction, distance: 20, target }], actorId: index === 0 ? 'local' : 'remote' }, pos, direction, undefined, index === 0);
        gunshots.tracer(pos, target, 'ar', false, index === 0);
        if (sequence % 3 === 0) gunshots.flesh(target, [0, 1, 0], index === 0);
        const slot = sequence % config.dirty, prior = editable.get(slot), content = unwrap(assets.read(prior));
        const values = content.attributes.position.slice(0, Math.min(24, content.attributes.position.length));
        values[0] += sequence % 2 ? 0.005 : -0.005;
        if (config.chunkPolicy === 'ranges') { unwrap(assets.writeRange(prior, { attribute: 'position', first: 0, values })); events.rangePatches++; }
        else {
          const next = unwrap(assets.copy(prior)); unwrap(assets.writeRange(next, { attribute: 'position', first: 0, values }));
          unwrap(world.set(entities[slot], MeshFilter, { assetHandle: next })); unwrap(assets.release(prior)); editable.set(slot, next); events.meshReplacements++;
        }
        operation.damage.push(slot);
      }
      unwrap(world.set(camera, Transform, { pos: [70 + Math.sin(elapsed) * 0.2, 32, 220] }));
      for (const [index, actor] of actors.entries()) unwrap(world.set(actor, Transform, { pos: [15 + index * 2 + Math.sin(elapsed) * 0.1, 3.7, 110] }));
      for (let index = 0; index < 16; index++) unwrap(world.set(fragmentEntities[index], Transform, { pos: [20 + index % 8 * 0.2, 4 + Math.sin(elapsed + index) * 0.1, 110 + Math.floor(index / 8) * 0.2] }));
      // A guarded source retirement is supplied only after the real minimum
      // age window; this fixture does not replace the Game's support checks.
      if (elapsed >= 8 && tick % 30 === 0) { const index = 16 + Math.floor(elapsed * 2) % 16; unwrap(world.despawn(fragmentEntities[index])); fragmentEntities[index] = fragment(index); events.fragmentRetirements++; operation.retiredFragments++; }
      gunshots.flush();
      return operation;
    },
  };
}
