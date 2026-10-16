function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, description) {
  if (!isRecord(value)) throw new Error(`${description} must be an object`);
  return value;
}

function requireNonNegativeInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${description} must be a non-negative safe integer`);
  return value;
}

function requireCount(value, description) {
  const count = requireRecord(value, description);
  return {
    candidates: requireNonNegativeInteger(count.candidates, `${description}.candidates`),
    visible: requireNonNegativeInteger(count.visible, `${description}.visible`),
    occluded: requireNonNegativeInteger(count.occluded, `${description}.occluded`),
  };
}

function addCount(target, value, description) {
  for (const key of ['candidates', 'visible', 'occluded']) {
    const sum = target[key] + value[key];
    if (!Number.isSafeInteger(sum)) throw new Error(`${description}.${key} exceeds safe integer`);
    target[key] = sum;
  }
}

function freezeTree(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function sameSubmit(left, right) {
  return (
    left?.frameId === right.frameId &&
    left?.deviceGeneration === right.deviceGeneration &&
    left?.build === right.build
  );
}

function requireNonEmptyString(value, description) {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${description} must be a non-empty string`);
  return value;
}

function requireSha256(value, description) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error(`${description} must be a lowercase SHA256 digest`);
  return value;
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('E03 input must be a Uint8Array');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function validateLodProducerManifest(value, expectedRoles) {
  const manifest = requireRecord(value, 'E03 producer manifest');
  if (manifest.schemaVersion !== 'e03-incremental-inputs/1')
    throw new Error('unsupported E03 producer manifest schema');
  const provenance = requireRecord(manifest.provenance, 'E03 manifest provenance');
  if (
    provenance.baseline !== 'f34758bab0284ac1d63f55b701170ab4d8793299' ||
    typeof provenance.producerHead !== 'string' ||
    !/^[a-f0-9]{40}$/.test(provenance.producerHead) ||
    provenance.producer !== 'produceSourcePackage(gltfImporter)'
  ) {
    throw new Error('E03 producer manifest has invalid producer provenance');
  }
  const roles = requireRecord(manifest.roles, 'E03 manifest roles');
  for (const name of ['root', 'middle', 'lowest', 'material', 'scene']) {
    const actual = requireNonEmptyString(roles[name], `E03 manifest roles.${name}`);
    if (actual !== expectedRoles?.[name])
      throw new Error(`E03 producer ${name} GUID does not match the app Meta`);
  }

  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 5)
    throw new Error('E03 producer manifest must contain exactly five original assets');
  const rows = new Map();
  for (const rowValue of manifest.assets) {
    const row = requireRecord(rowValue, 'E03 manifest asset row');
    const guid = requireNonEmptyString(row.guid, 'E03 asset GUID');
    if (rows.has(guid)) throw new Error(`E03 producer manifest repeats asset ${guid}`);
    if (!['mesh', 'material', 'scene'].includes(row.kind))
      throw new Error(`E03 producer asset ${guid} has an unsupported kind`);
    if (row.path !== `assets/${guid}.json`)
      throw new Error(`E03 producer asset ${guid} has an unexpected JSON path`);
    if (!Number.isSafeInteger(row.byteLength) || row.byteLength <= 0)
      throw new Error(`E03 producer asset ${guid} has an invalid byte length`);
    requireSha256(row.sha256, `E03 producer asset ${guid} SHA256`);
    if (!Array.isArray(row.refs)) throw new Error(`E03 producer asset ${guid} is missing refs`);
    for (const refValue of row.refs) {
      const ref = requireRecord(refValue, `E03 producer asset ${guid} ref`);
      requireNonEmptyString(ref.guid, `E03 producer asset ${guid} ref GUID`);
      requireRecord(ref.sourceField, `E03 producer asset ${guid} ref sourceField`);
    }
    const artifacts = requireRecord(row.artifacts, `E03 producer asset ${guid} artifacts`);
    for (const [key, artifactValue] of Object.entries(artifacts)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(key))
        throw new Error(`E03 producer asset ${guid} has an invalid artifact key`);
      const artifact = requireRecord(artifactValue, `E03 producer asset ${guid} artifact ${key}`);
      if (artifact.path !== `artifacts/${guid}-${key}.bin`)
        throw new Error(`E03 producer asset ${guid} artifact ${key} has an unexpected path`);
      if (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength <= 0)
        throw new Error(`E03 producer asset ${guid} artifact ${key} has an invalid byte length`);
      if (artifact.contentEncoding !== 'identity')
        throw new Error(`E03 producer asset ${guid} artifact ${key} is not identity encoded`);
      const integrity = requireRecord(
        artifact.integrity,
        `E03 producer asset ${guid} artifact ${key} integrity`,
      );
      if (integrity.algorithm !== 'sha256')
        throw new Error(`E03 producer asset ${guid} artifact ${key} must use SHA256`);
      requireSha256(integrity.digest, `E03 producer asset ${guid} artifact ${key} digest`);
    }
    rows.set(guid, row);
  }

  const expectedKinds = [
    ['root', 'mesh'],
    ['middle', 'mesh'],
    ['lowest', 'mesh'],
    ['material', 'material'],
    ['scene', 'scene'],
  ];
  for (const [name, kind] of expectedKinds) {
    if (rows.get(roles[name])?.kind !== kind)
      throw new Error(`E03 producer ${name} does not resolve to a ${kind} asset`);
  }
  const rootRefs = rows.get(roles.root).refs;
  const requiredRootRefs = [roles.material, roles.middle, roles.lowest];
  if (
    !sameJsonValue(
      rootRefs.map((ref) => ref.guid),
      requiredRootRefs,
    )
  )
    throw new Error('E03 root AssetRef order no longer matches material, middle and lowest');

  const admission = requireRecord(manifest.admission, 'E03 manifest admission');
  if (
    !sameJsonValue(admission.initial, [roles.material, roles.middle, roles.root]) ||
    !sameJsonValue(admission.later, [roles.lowest]) ||
    !sameJsonValue(admission.excluded, [roles.scene]) ||
    admission.route !== 'public loaders -> AssetRegistry.catalog(original guid, payload, refs)'
  ) {
    throw new Error('E03 producer admission does not match the fixed incremental route');
  }
  const shaderClosure = requireRecord(manifest.shaderClosure, 'E03 shader closure');
  if (
    shaderClosure.status !== 'cpu-publication-verified' ||
    shaderClosure.gpuReadiness !== 'unverified'
  ) {
    throw new Error('E03 shader closure must keep GPU readiness unverified');
  }
  const publication = requireRecord(shaderClosure.publication, 'E03 shader publication');
  if (publication.path !== 'shaders/manifest.json' || publication.byteLength <= 0)
    throw new Error('E03 shader publication path or length is invalid');
  requireSha256(publication.sha256, 'E03 shader publication SHA256');
  return manifest;
}

/** Bind publication bytes to the producer explicitly selected by the Node host. */
export async function verifyLodProducerManifestBytes(bytes, expectedRoles, producer) {
  requireRecord(producer, 'E03 expected producer identity');
  requireSha256(producer.manifestSha256, 'E03 expected manifest SHA256');
  if (typeof producer.producerHead !== 'string' || !/^[a-f0-9]{40}$/.test(producer.producerHead))
    throw new Error('E03 expected producer commit must be a full Git SHA');
  const digest = await sha256Hex(bytes);
  if (digest !== producer.manifestSha256)
    throw new Error(`E03 producer manifest SHA256 mismatch: ${digest}`);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`E03 producer manifest JSON is invalid: ${String(error)}`);
  }
  const manifest = validateLodProducerManifest(parsed, expectedRoles);
  if (manifest.provenance.producerHead !== producer.producerHead)
    throw new Error('E03 producer manifest does not match the selected producer commit');
  return Object.freeze({ manifest: freezeTree(manifest), sha256: digest });
}

/** Catalog real producer rows through the host's public loaders and AssetRegistry. */
export async function catalogLodProducerAssets(assets, manifestValue, readBytes, expectedRoles) {
  const manifest = validateLodProducerManifest(manifestValue, expectedRoles);
  const readVerified = async (path, digest, byteLength) => {
    const bytes = await readBytes(path);
    if (!(bytes instanceof Uint8Array)) throw new Error(`E03 input ${path} is not bytes`);
    if (bytes.byteLength !== byteLength) throw new Error(`E03 input ${path} byte length mismatch`);
    if ((await sha256Hex(bytes)) !== digest) throw new Error(`E03 input ${path} SHA256 mismatch`);
    return bytes;
  };
  const decodeAndCatalog = async (guid) => {
    const row = manifest.assets.find((candidate) => candidate.guid === guid);
    if (!row) throw new Error(`E03 producer manifest is missing ${guid}`);
    const documentBytes = await readVerified(row.path, row.sha256, row.byteLength);
    const document = requireRecord(
      JSON.parse(new TextDecoder().decode(documentBytes)),
      `E03 producer asset ${guid}`,
    );
    if (
      document.guid !== row.guid ||
      document.kind !== row.kind ||
      !sameJsonValue(document.refs, row.refs)
    ) {
      throw new Error(`E03 producer asset ${guid} no longer matches its manifest identity`);
    }
    const artifactInputs = {};
    for (const [key, descriptorValue] of Object.entries(row.artifacts)) {
      const descriptor = requireRecord(descriptorValue, `E03 producer artifact ${key}`);
      const integrity = requireRecord(
        descriptor.integrity,
        `E03 producer artifact ${key} integrity`,
      );
      const bytes = await readVerified(descriptor.path, integrity.digest, descriptor.byteLength);
      artifactInputs[key] = { descriptor, bytes };
    }
    const payload = requireRecord(document.payload, `E03 producer asset ${guid} payload`);
    const loaded = await assets.loaders.loadPack(
      {
        guid,
        kind: row.kind,
        payload,
        refs: row.refs.map((ref) => ref.guid),
        artifacts: artifactInputs,
      },
      {
        fetchBinary: async () => {
          throw new Error('E03 producer bytes are supplied explicitly');
        },
        resolveRef: async () => {
          throw new Error('E03 producer refs must remain unresolved during incremental catalog');
        },
        transcodeCaps: { bc: false, etc2: false, astc: false },
        device: undefined,
      },
    );
    if (!loaded.ok) throw new Error(`E03 public loader rejected ${guid}: ${String(loaded.error)}`);
    if (loaded.value === undefined)
      throw new Error(`E03 public loader returned no payload for ${guid}`);
    const cataloged = assets.catalog(guid, loaded.value, row.refs);
    if (!cataloged.ok)
      throw new Error(`E03 AssetRegistry rejected ${guid}: ${String(cataloged.error)}`);
    return loaded.value;
  };

  for (const guid of manifest.admission.initial) await decodeAndCatalog(guid);
  if (assets.lookup(manifest.roles.lowest) !== undefined)
    throw new Error('E03 lowest LOD was admitted before its manifest stage');
  return {
    manifest,
    admitLowest: () => decodeAndCatalog(manifest.roles.lowest),
  };
}

function requireSamples(value, description) {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error(`${description} exceeds the 64 sample limit`);
  for (const sampleValue of value) {
    const sample = requireRecord(sampleValue, `${description} sample`);
    requireNonNegativeInteger(sample.primitiveSlot, `${description} sample primitiveSlot`);
    requireNonNegativeInteger(sample.level, `${description} sample level`);
    if (typeof sample.visible !== 'boolean')
      throw new Error(`${description} sample visible must be a boolean`);
  }
}

function summarizeHistogram(rows, description) {
  const histogram = new Map();
  for (const row of rows) {
    if (!Array.isArray(row.lodHistogram))
      throw new Error(`${description} is missing its LOD histogram`);
    const seenLevels = new Set();
    for (const entryValue of row.lodHistogram) {
      const entry = requireRecord(entryValue, `${description} histogram entry`);
      const level = requireNonNegativeInteger(entry.level, `${description} histogram level`);
      const amount = requireNonNegativeInteger(entry.count, `${description} histogram count`);
      if (seenLevels.has(level)) throw new Error(`${description} repeats LOD level ${level}`);
      seenLevels.add(level);
      const sum = (histogram.get(level) ?? 0) + amount;
      if (!Number.isSafeInteger(sum))
        throw new Error(`${description} histogram exceeds safe integer`);
      histogram.set(level, sum);
    }
  }
  return [...histogram.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, count]) => ({ level, count }));
}

/**
 * Convert one detached `observed.value` into immutable two-view evidence.
 * The renderer's live inspection is deliberately not an accepted input.
 */
export function summarizeLodObservation(observedValue, receipt, cameraEntityIds, rootMeshHandle) {
  const observed = requireRecord(observedValue, 'FrameReceiptObservation');
  const expectedReceipt = requireRecord(receipt, 'FrameReceipt');
  if (
    observed.frameId !== expectedReceipt.frameId ||
    observed.deviceGeneration !== expectedReceipt.deviceGeneration
  ) {
    throw new Error('receipt observation does not match the completed FrameReceipt');
  }
  if (!Array.isArray(observed.include) || !observed.include.includes('lod-occlusion')) {
    throw new Error('receipt observation did not request lod-occlusion');
  }

  const lod = requireRecord(observed.lodOcclusion, 'receipt LOD snapshot');
  if (!Array.isArray(cameraEntityIds) || cameraEntityIds.length !== 2)
    throw new Error('LOD evidence requires exactly two expected CameraViews');
  if (
    cameraEntityIds.some(
      (cameraEntity) => !Number.isSafeInteger(cameraEntity) || cameraEntity < 0,
    ) ||
    new Set(cameraEntityIds).size !== cameraEntityIds.length
  ) {
    throw new Error('expected CameraView identities must be unique');
  }
  const expectedRootIdentity = `asset-handle:${requireNonNegativeInteger(rootMeshHandle, 'expected root MeshAsset handle')}`;
  if (!Array.isArray(lod.views)) throw new Error('receipt LOD snapshot is missing its view roster');
  if (new TextEncoder().encode(JSON.stringify(lod)).byteLength > 16 * 1024)
    throw new Error('receipt LOD snapshot exceeds 16 KiB');

  if (lod.status === 'unavailable') {
    const reasons = new Set([
      'not-captured',
      'superseded',
      'empty-display-roster',
      'held-view',
      'attachment-unavailable',
      'lease-detached',
      'view-retired',
      'camera-generation-mismatch',
      'graph-generation-mismatch',
      'lod-readback-unavailable',
      'world-attribution-unavailable',
      'unsupported-lod-lane',
      'snapshot-too-large',
    ]);
    if (!reasons.has(lod.reason))
      throw new Error('receipt LOD snapshot has an unknown unavailable reason');
    throw new Error(`receipt LOD snapshot is unavailable: ${lod.reason}`);
  }
  if (lod.status !== 'complete') throw new Error('receipt LOD snapshot has an unknown status');
  if (lod.views.length !== cameraEntityIds.length) {
    throw new Error('receipt LOD snapshot does not contain the complete CameraView roster');
  }

  const viewsByCamera = new Map();
  const viewKeys = new Set();
  let receiptBuild;
  let attachmentId;
  for (const viewValue of lod.views) {
    const view = requireRecord(viewValue, 'receipt CameraView');
    const cameraEntity = requireNonNegativeInteger(view.entityKey, 'receipt CameraView entityKey');
    if (!cameraEntityIds.includes(cameraEntity))
      throw new Error(`receipt LOD snapshot contains unknown CameraView ${cameraEntity}`);
    if (viewsByCamera.has(cameraEntity))
      throw new Error(`receipt LOD snapshot repeats CameraView ${cameraEntity}`);
    const viewKey = requireNonEmptyString(view.viewKey, `CameraView ${cameraEntity} viewKey`);
    if (viewKeys.has(viewKey)) throw new Error(`receipt LOD snapshot repeats viewKey ${viewKey}`);
    viewKeys.add(viewKey);
    const viewAttachmentId = requireNonEmptyString(
      view.attachmentId,
      `CameraView ${cameraEntity} attachmentId`,
    );
    if (attachmentId !== undefined && viewAttachmentId !== attachmentId)
      throw new Error('receipt CameraViews belong to different attachments');
    attachmentId = viewAttachmentId;
    if (view.state !== 'rendered')
      throw new Error(`CameraView ${cameraEntity} was not rendered for this receipt`);
    const viewGeneration = requireNonNegativeInteger(
      view.viewGeneration,
      `CameraView ${cameraEntity} generation`,
    );
    const graphGeneration = requireNonNegativeInteger(
      view.graphGeneration,
      `CameraView ${cameraEntity} graph generation`,
    );
    let eye;
    if (view.eye !== undefined) {
      if (view.eye !== 'left' && view.eye !== 'right')
        throw new Error(`CameraView ${cameraEntity} has an invalid stereo eye`);
      eye = view.eye;
    }
    const lodInspection = requireRecord(
      view.lodOcclusion,
      `CameraView ${cameraEntity} LOD inspection`,
    );
    if (lodInspection.schema !== 'forgeax::lod-occlusion-inspection::v3')
      throw new Error(`CameraView ${cameraEntity} has an unsupported LOD inspection schema`);
    const submit = requireRecord(
      lodInspection.submit,
      `CameraView ${cameraEntity} submit identity`,
    );
    if (
      submit.frameId !== expectedReceipt.frameId ||
      submit.deviceGeneration !== expectedReceipt.deviceGeneration ||
      typeof submit.build !== 'string' ||
      submit.build.length === 0
    ) {
      throw new Error(
        `CameraView ${cameraEntity} LOD inspection does not match the completed FrameReceipt`,
      );
    }
    if (receiptBuild !== undefined && submit.build !== receiptBuild)
      throw new Error('CameraView LOD inspections have different build identities');
    receiptBuild = submit.build;

    const inspectionRoot = requireRecord(lodInspection.root, `CameraView ${cameraEntity} LOD root`);
    if (inspectionRoot.guid !== expectedRootIdentity)
      throw new Error(
        `CameraView ${cameraEntity} inspection belongs to a different root MeshAsset`,
      );
    requireNonEmptyString(inspectionRoot.sourceKey, `CameraView ${cameraEntity} root sourceKey`);
    const inspectionSlot = requireRecord(lodInspection.slot, `CameraView ${cameraEntity} LOD slot`);
    requireNonNegativeInteger(
      inspectionSlot.primitiveSlot,
      `CameraView ${cameraEntity} primitiveSlot`,
    );
    requireNonNegativeInteger(
      inspectionSlot.slotGeneration,
      `CameraView ${cameraEntity} slotGeneration`,
    );
    requireNonNegativeInteger(
      lodInspection.generation,
      `CameraView ${cameraEntity} LOD generation`,
    );

    const primaryView = requireRecord(
      lodInspection.view,
      `CameraView ${cameraEntity} LOD view identity`,
    );
    if (
      primaryView.cameraEntity !== cameraEntity ||
      primaryView.attachmentId !== viewAttachmentId ||
      primaryView.viewRole !== 'main' ||
      primaryView.viewGeneration !== viewGeneration
    ) {
      throw new Error(
        `CameraView ${cameraEntity} LOD inspection has mixed or invalid source identity`,
      );
    }
    const worlds = lodInspection.worlds;
    if (!Array.isArray(worlds) || worlds.length !== 1)
      throw new Error(`CameraView ${cameraEntity} must report exactly one receipt World`);
    const world = requireRecord(worlds[0], `CameraView ${cameraEntity} receipt World`);
    if (world.attachmentId !== viewAttachmentId)
      throw new Error(`CameraView ${cameraEntity} World has a different attachment identity`);
    const worldAttribution = requireRecord(
      world.attribution,
      `CameraView ${cameraEntity} World attribution`,
    );
    if (worldAttribution.status !== 'same-submit' || !sameSubmit(worldAttribution.submit, submit))
      throw new Error(`CameraView ${cameraEntity} World attribution is not same-submit`);
    if (!Array.isArray(world.rows) || world.rows.length === 0)
      throw new Error(`CameraView ${cameraEntity} same-submit World rows are unavailable`);

    const rows = [];
    for (const rowValue of world.rows) {
      const row = requireRecord(rowValue, `CameraView ${cameraEntity} LOD row`);
      const rowRoot = requireRecord(row.root, `CameraView ${cameraEntity} row root`);
      if (rowRoot.guid !== expectedRootIdentity)
        throw new Error(`CameraView ${cameraEntity} row belongs to a different root MeshAsset`);
      requireNonEmptyString(rowRoot.sourceKey, `CameraView ${cameraEntity} row sourceKey`);
      const rowView = requireRecord(row.view, `CameraView ${cameraEntity} row view identity`);
      if (
        rowView.cameraEntity !== cameraEntity ||
        rowView.attachmentId !== viewAttachmentId ||
        rowView.viewRole !== 'main' ||
        rowView.viewGeneration !== viewGeneration
      ) {
        throw new Error(`CameraView ${cameraEntity} row has mixed or invalid source identity`);
      }
      const rowSlot = requireRecord(row.slot, `CameraView ${cameraEntity} row slot`);
      requireNonNegativeInteger(
        rowSlot.primitiveSlot,
        `CameraView ${cameraEntity} row primitiveSlot`,
      );
      requireNonNegativeInteger(
        rowSlot.slotGeneration,
        `CameraView ${cameraEntity} row slotGeneration`,
      );
      requireNonNegativeInteger(row.generation, `CameraView ${cameraEntity} row generation`);
      requireSamples(row.samples, `CameraView ${cameraEntity} row`);
      rows.push({
        count: requireCount(row.count, `CameraView ${cameraEntity} count`),
        lodHistogram: row.lodHistogram,
      });
    }
    const rowCount = { candidates: 0, visible: 0, occluded: 0 };
    for (const row of rows) addCount(rowCount, row.count, `CameraView ${cameraEntity} count`);
    const rowHistogram = summarizeHistogram(rows, `CameraView ${cameraEntity}`);
    const inspectionCount = requireCount(
      lodInspection.count,
      `CameraView ${cameraEntity} inspection count`,
    );
    const inspectionHistogram = summarizeHistogram(
      [{ lodHistogram: lodInspection.lodHistogram }],
      `CameraView ${cameraEntity} inspection`,
    );
    if (
      ['candidates', 'visible', 'occluded'].some((key) => inspectionCount[key] !== rowCount[key]) ||
      JSON.stringify(inspectionHistogram) !== JSON.stringify(rowHistogram)
    ) {
      throw new Error(
        `CameraView ${cameraEntity} inspection totals do not match same-submit World rows`,
      );
    }
    requireSamples(lodInspection.samples, `CameraView ${cameraEntity} inspection`);
    viewsByCamera.set(cameraEntity, {
      cameraEntity,
      viewKey,
      eye,
      attachmentId: viewAttachmentId,
      viewGeneration,
      graphGeneration,
      rows,
      count: rowCount,
      lodHistogram: rowHistogram,
    });
  }
  if (cameraEntityIds.some((cameraEntity) => !viewsByCamera.has(cameraEntity)))
    throw new Error('receipt LOD snapshot is missing an expected CameraView');

  const cameraViews = cameraEntityIds.map((cameraEntity) => {
    const view = viewsByCamera.get(cameraEntity);
    return {
      cameraEntity,
      entityKey: cameraEntity,
      viewKey: view.viewKey,
      eye: view.eye,
      attachmentId: view.attachmentId,
      lodRows: view.rows.length,
      viewGeneration: view.viewGeneration,
      graphGeneration: view.graphGeneration,
      count: view.count,
      lodHistogram: view.lodHistogram,
    };
  });

  const aggregate = { candidates: 0, visible: 0, occluded: 0 };
  for (const view of cameraViews) addCount(aggregate, view.count, 'aggregate count');
  const aggregateHistogram = new Map();
  for (const view of cameraViews) {
    for (const entry of view.lodHistogram) {
      const sum = (aggregateHistogram.get(entry.level) ?? 0) + entry.count;
      if (!Number.isSafeInteger(sum)) throw new Error('aggregate histogram exceeds safe integer');
      aggregateHistogram.set(entry.level, sum);
    }
  }

  return freezeTree({
    submit: {
      frameId: expectedReceipt.frameId,
      deviceGeneration: expectedReceipt.deviceGeneration,
      build: receiptBuild,
    },
    attachmentId,
    attribution: {
      status: 'same-submit',
      submit: {
        frameId: expectedReceipt.frameId,
        deviceGeneration: expectedReceipt.deviceGeneration,
        build: receiptBuild,
      },
    },
    aggregate: {
      ...aggregate,
      lodHistogram: [...aggregateHistogram.entries()]
        .sort(([left], [right]) => left - right)
        .map(([level, count]) => ({ level, count })),
    },
    cameraViews,
  });
}

/** Empty scenes have no attributable LOD row; prove absence from the same submitted draws. */
export function summarizeHiddenObservation(observedValue, receipt, cameraEntityIds, worldIdentity) {
  const observed = requireRecord(observedValue, 'FrameReceiptObservation');
  if (
    observed.frameId !== receipt.frameId ||
    observed.deviceGeneration !== receipt.deviceGeneration
  )
    throw new Error('hidden observation does not match the completed FrameReceipt');
  if (
    !Array.isArray(observed.include) ||
    !['lod-occlusion', 'draws'].every((value) => observed.include.includes(value))
  )
    throw new Error('hidden observation must request draws and the CameraView roster');
  const draws = requireRecord(observed.draws, 'hidden draw observation');
  if (draws.status !== 'complete' || !Array.isArray(draws.draws) || draws.draws.length !== 0)
    throw new Error('hidden scene requires an empty completed draw observation');
  requireNonEmptyString(worldIdentity, 'hidden World identity');
  if (
    !Array.isArray(cameraEntityIds) ||
    cameraEntityIds.length !== 2 ||
    new Set(cameraEntityIds).size !== 2
  )
    throw new Error('hidden evidence requires exactly two expected CameraViews');
  for (const id of cameraEntityIds) requireNonNegativeInteger(id, 'expected CameraView');
  const lod = requireRecord(observed.lodOcclusion, 'hidden CameraView roster');
  if (lod.status !== 'unavailable' || lod.reason !== 'lod-readback-unavailable')
    throw new Error(
      'hidden CameraView roster must report only empty-scene LOD readback unavailability',
    );
  if (!Array.isArray(lod.views) || lod.views.length !== cameraEntityIds.length)
    throw new Error('hidden observation has an incomplete CameraView roster');
  if (new TextEncoder().encode(JSON.stringify(lod)).byteLength > 16 * 1024)
    throw new Error('hidden CameraView roster exceeds 16 KiB');
  const views = new Map();
  const keys = new Set();
  for (const value of lod.views) {
    const view = requireRecord(value, 'hidden CameraView');
    if (!cameraEntityIds.includes(view.entityKey) || views.has(view.entityKey))
      throw new Error('hidden observation has an unknown or repeated CameraView');
    if (view.state !== 'rendered') throw new Error('hidden CameraView was not rendered');
    if (view.attachmentId !== worldIdentity)
      throw new Error('hidden CameraView has the wrong World');
    const viewKey = requireNonEmptyString(view.viewKey, 'hidden CameraView key');
    if (keys.has(viewKey)) throw new Error('hidden observation repeats a CameraView key');
    keys.add(viewKey);
    views.set(view.entityKey, {
      cameraEntity: view.entityKey,
      entityKey: view.entityKey,
      viewKey,
      attachmentId: worldIdentity,
      viewGeneration: requireNonNegativeInteger(
        view.viewGeneration,
        'hidden CameraView generation',
      ),
      graphGeneration: requireNonNegativeInteger(view.graphGeneration, 'hidden graph generation'),
    });
  }
  const submit = { frameId: receipt.frameId, deviceGeneration: receipt.deviceGeneration };
  return freezeTree({
    submit,
    attachmentId: worldIdentity,
    attribution: { status: 'same-submit', submit },
    cameraViews: cameraEntityIds.map((id) => views.get(id)),
    draws,
    lodObservation: lod,
  });
}

/** A serial queue ensures the next draw cannot overtake completion/observation. */
export function createSerialFrameQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(work) {
      const result = tail.then(work);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    drain() {
      return tail;
    },
  };
}

/** Count completions separately from complete, unique receipt evidence. */
export function createLodPhaseProgress() {
  let epoch = 0;
  let phase = 'interactive';
  let frameLimit;
  let phaseCompletedFrames = 0;
  let phaseAcceptedFrames = 0;
  let totalCompletedFrames = 0;
  let totalAcceptedFrames = 0;
  let lastCompletedFrameId = -1;
  let lastAcceptedFrameId = -1;
  let latestReceipt;
  let latestEvidence;

  return {
    beginPhase(nextPhase, nextFrameLimit = 60) {
      if (typeof nextPhase !== 'string' || nextPhase.length === 0)
        throw new Error('phase name must be non-empty');
      if (!Number.isSafeInteger(nextFrameLimit) || nextFrameLimit <= 0)
        throw new Error('phase frame limit must be a positive safe integer');
      epoch += 1;
      phase = nextPhase;
      frameLimit = nextFrameLimit;
      phaseCompletedFrames = 0;
      phaseAcceptedFrames = 0;
      latestEvidence = undefined;
      return Object.freeze({ phase, epoch });
    },
    markCompleted(token, receipt) {
      totalCompletedFrames += 1;
      const frameId = receipt?.frameId;
      const uniqueIncreasing = Number.isSafeInteger(frameId) && frameId > lastCompletedFrameId;
      if (uniqueIncreasing) lastCompletedFrameId = frameId;
      const currentPhase = token?.epoch === epoch;
      if (currentPhase) phaseCompletedFrames += 1;
      const completed = {
        epoch: token?.epoch,
        phase: token?.phase,
        frameId,
        deviceGeneration: receipt?.deviceGeneration,
        uniqueIncreasing,
        currentPhase,
      };
      if (uniqueIncreasing) {
        latestReceipt = {
          frameId,
          deviceGeneration: receipt.deviceGeneration,
        };
      }
      return Object.freeze(completed);
    },
    accept(token, completed, evidence) {
      if (
        token?.epoch !== epoch ||
        completed?.epoch !== epoch ||
        completed?.currentPhase !== true ||
        completed?.uniqueIncreasing !== true ||
        completed.frameId !== evidence?.submit?.frameId ||
        completed.deviceGeneration !== evidence?.submit?.deviceGeneration ||
        completed.frameId <= lastAcceptedFrameId ||
        phaseAcceptedFrames >= frameLimit
      ) {
        return false;
      }
      phaseAcceptedFrames += 1;
      totalAcceptedFrames += 1;
      lastAcceptedFrameId = completed.frameId;
      latestEvidence = freezeTree(evidence);
      return true;
    },
    snapshot() {
      return {
        phase,
        phaseEpoch: epoch,
        phaseCompletedFrames,
        phaseAcceptedFrames,
        totalCompletedFrames,
        totalAcceptedFrames,
        latestReceipt: latestReceipt === undefined ? undefined : { ...latestReceipt },
        latestEvidence,
      };
    },
  };
}

export function selectedLod(cameraEvidence) {
  if (cameraEvidence?.lodHistogram === undefined) return undefined;
  let level;
  for (const row of cameraEvidence.lodHistogram) if (row.count > 0) level = row.level;
  return level;
}

export async function observeCompletedReceipt(receipt, observe, onCompleted) {
  let completed;
  try {
    completed = await receipt.completed;
  } catch (error) {
    return { status: 'completion-failed', receipt, error };
  }
  if (!completed.ok) return { status: 'completion-failed', receipt, error: completed.error };
  const completion = onCompleted(receipt);
  try {
    const observed = await observe(receipt);
    if (!observed.ok)
      return { status: 'observation-failed', receipt, completion, error: observed.error };
    return { status: 'observed', receipt, completion, value: observed.value };
  } catch (error) {
    return { status: 'observation-failed', receipt, completion, error };
  }
}
