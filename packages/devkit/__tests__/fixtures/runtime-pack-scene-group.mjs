import { FixedTime } from '@forgeax/engine/ecs';
import { createBoxGeometry } from '@forgeax/engine/geometry';
import { RigidBody, RigidBodyTypeValue } from '@forgeax/engine/physics';
import physicsPlugin from '@forgeax/engine/physics-rapier3d';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { err, ok } from '@forgeax/engine/types';
import { boxPoints } from './convex-geometry-fixture.mjs';

export { physicsPlugin };

export function runtimePackSceneGroup(ctx, loadPair, getRenderWorker) {
  const { world, assets, physics } = ctx;
  const geometry = ctx.executionBootstrapHost.dynamicGeometry;
  if (geometry === undefined || physics === undefined)
    throw new Error('The scene group requires the split Render Worker and Rapier');
  const centers = [-2.2, 2.2];
  const held = [];
  const entities = [];
  const lifetime = new AbortController();
  let material;
  let prepared;
  let adopted = [];
  let adoptedStep;
  let refusal;
  let releaseAcknowledgements = 0;
  const firstFrames = new Map();

  function recordFirstFrames({ data }) {
    if (data.kind === 'mesh-released' && data.result.ok) releaseAcknowledgements++;
    if (data.kind !== 'completed' || data.frame.presentation !== 'ready') return;
    for (const candidate of adopted) {
      if (firstFrames.has(candidate.candidateId)) continue;
      const receipt = geometry.dynamicGeometryReceipt(candidate);
      if (receipt?.frameId !== data.completion.frameId) continue;
      firstFrames.set(candidate.candidateId, {
        frameId: receipt.frameId,
        fixedStep: receipt.fixedStep,
        publicationFixedStep: receipt.publicationFixedStep,
        recordStageConsumed: receipt.recordStageConsumed,
      });
    }
  }

  function inspect() {
    return {
      world: world.identity,
      entities,
      bodiesReady: entities.length === centers.length && entities.every((id) => physics.hasBody(id)),
      bindings: entities.map((id) => world.get(id, MeshFilter).unwrap().assetHandle),
      collisions: entities.map((id) => physics.getDerivedPublication(id)?.revision ?? null),
      hits: centers.map((x) => physics.raycast([x + 1.2, 0, 4], [0, 0, -1], 8)?.entity ?? null),
      adoptedStep: adoptedStep ?? null,
      firstFrames: adopted.map((candidate) => firstFrames.get(candidate.candidateId) ?? null),
      refusedCode: refusal?.code ?? null,
      releaseAcknowledgements,
      recoveries: entities.map((id) => physics.getDerivedFailure(id)?.recovery ?? null),
    };
  }

  function preparePhysics(revision, width) {
    return physics.prepareDerivedShapeCandidates(
      entities.map((entity) => ({
        entity,
        revision,
        sourceKey: `runtime-pack:split-scene-group:${entity}`,
        worldIdentity: world,
        bodyType: 'static',
        shapes: [{
          id: 'wall',
          revision,
          kind: 'convex-compound',
          pieces: [boxPoints([-width / 2, -1, -1], [width / 2, 1, 1])],
        }],
      })),
    ).unwrap();
  }

  async function prepare(handles, revision) {
    const result = await geometry.prepareDynamicGeometryCandidates(
      entities.map((entity, index) => ({
        world,
        entity,
        physicsEntity: entity,
        meshHandle: handles[index],
        revision,
      })),
      { signal: lifetime.signal },
    );
    prepared = result.unwrap();
    return { ...inspect(), pendingBindings: handles };
  }

  return {
    commands: {
      async mountSceneGroup() {
        // Startup has installed the App handler. Read its committed receipt
        // during the same completion event, before a later frame can refresh it.
        getRenderWorker().addEventListener('message', recordFirstFrames, { signal: lifetime.signal });
        const { handles, publications } = await loadPair();
        held.push(...handles);
        material = assets.create(Materials.unlit([0.14, 0.68, 0.22, 1])).unwrap();
        for (const [index, x] of centers.entries()) {
          entities.push(world.spawn(
            { component: Transform, data: { pos: [x, 0, 0] } },
            { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
            { component: MeshFilter, data: { assetHandle: handles[index] } },
            { component: MeshRenderer, data: { materials: [material] } },
          ).unwrap());
        }
        return { ...inspect(), publications };
      },
      armInitialSceneGroup() {
        physics.admitDerivedShapeCandidates(preparePhysics(1, 1), () => ok(undefined)).unwrap();
      },
      async prepareNextSceneGroup() {
        const { handles, publications } = await loadPair(true);
        held.push(...handles);
        return { ...(await prepare(handles, 2)), publications };
      },
      async prepareStaleSceneGroup() {
        const handles = held.slice(0, 2);
        const state = await prepare(handles, 3);
        // Change just one pending source Mesh. The currently displayed pair
        // has separate handles and remains ready throughout the refusal.
        assets.replace(handles[0], createBoxGeometry(1.1, 2, 2).unwrap()).unwrap();
        return state;
      },
      admitSceneGroup(revision, width) {
        if (prepared === undefined) throw new Error('Scene group has not been prepared');
        const candidates = prepared;
        physics.admitDerivedShapeCandidates(preparePhysics(revision, width), () => {
          const fixedStep = world.getResource(FixedTime).tick;
          const accepted = geometry.acceptDynamicGeometryCandidates(candidates, { world, fixedStep });
          if (!accepted.ok) {
            refusal = { code: accepted.error.code, candidates };
            return err(accepted.error);
          }
          adopted = accepted.value;
          adoptedStep = fixedStep;
          firstFrames.clear();
          return ok(undefined);
        }).unwrap();
        prepared = undefined;
      },
      cancelRefusedSceneGroup() {
        if (refusal === undefined || refusal.candidates.length === 0)
          throw new Error('No refused scene group is awaiting cleanup');
        for (const candidate of refusal.candidates)
          geometry.cancelDynamicGeometry(candidate).unwrap();
        refusal.candidates = [];
      },
      inspectSceneGroup: inspect,
    },
    dispose() {
      lifetime.abort();
      for (const entity of entities) world.despawn(entity).unwrap();
      for (const handle of held) assets.release(handle).unwrap();
      if (material !== undefined) assets.release(material).unwrap();
    },
  };
}
