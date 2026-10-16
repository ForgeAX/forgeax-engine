import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTriangleQuery } from '../../../packages/geometry/src/triangle-query.ts';
import { buildFrameModel, decodeTape } from '../../../packages/rhi-debug/dist/index.mjs';
import { rasterTriangleWitness } from './raster-receiver.mjs';

const [cardsPath, associationPath, referencePath] = process.argv.slice(2, 5).map((p) => resolve(p));
const rasterGrid = Number(process.argv[5] ?? 0);
const reportPath = resolve(
  process.argv[6] ?? resolve(associationPath, 'material-correspondence.json'),
);
assert(Number.isInteger(rasterGrid) && rasterGrid >= 0 && rasterGrid <= 65536);
assert(
  cardsPath && associationPath && referencePath,
  'inspect-card-correspondence <cards.json> <association-output> <material-reference-output>',
);
const read = async (dir, name) => new Uint8Array(await readFile(resolve(dir, name)));
const json = async (dir, name) => JSON.parse(new TextDecoder().decode(await read(dir, name)));
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cardBytes = await readFile(cardsPath),
  cards = JSON.parse(cardBytes);
const diagnosis = await json(associationPath, 'gap-diagnosis.json'),
  gpu = await json(associationPath, 'gpu.json');
const reference = await json(referencePath, 'gpu.json');
assert.equal(sha(cardBytes), diagnosis.cardSha256);
assert.deepEqual(reference.gpuErrors, []);
assert.deepEqual(reference.errors, []);
assert(reference.checks.length === reference.cohorts.length * 3);
assert(reference.checks.every((c) => c.differentBytes === 0));
assert.deepEqual(reference.unseededResources, []);
const referenceBytes = async (name) => {
  const bytes = await read(referencePath, name);
  assert.equal(sha(bytes), reference.artifacts[name], `reference digest mismatch: ${name}`);
  return bytes;
};
const cohorts = JSON.parse(new TextDecoder().decode(await referenceBytes('cohorts.json')));
const maskMaterials = new Set(
  cards.sources
    .flatMap((s) => s.sections)
    .filter((s) => (s.material.asset.values.alphaCutoff ?? 0) > 0)
    .map((s) => s.material.id),
);
const tapeBytes = await read(associationPath, 'global-cards.rhitape');
assert.equal(sha(tapeBytes), diagnosis.tapeSha256);
const tape = decodeTape(tapeBytes).unwrap(),
  model = buildFrameModel(tape);
const initial = (work, binding) => {
  const id = work.bindings.find((b) => b.groupIndex === 0 && b.binding === binding).resourceId;
  const row = tape.bootstrap.find((r) => r.handleId === id);
  assert.equal(row.initialData.length, 1);
  return view(tape.blobs.find((b) => b.hash === row.initialData[0].hash).bytes);
};
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const geometry = new Map(),
  directionQueries = new Map();
for (const source of cards.sources) {
  const m = source.instance.transform,
    p = source.instance.positions,
    indices = source.instance.indices;
  const determinant =
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[4] * (m[1] * m[10] - m[2] * m[9]) +
    m[8] * (m[1] * m[6] - m[2] * m[5]);
  assert(determinant !== 0);
  const positions = Array.from({ length: p.length / 3 }, (_, i) =>
    [0, 1, 2].map((a) =>
      Math.fround(m[a] * p[i * 3] + m[a + 4] * p[i * 3 + 1] + m[a + 8] * p[i * 3 + 2] + m[a + 12]),
    ),
  );
  const triangles = [],
    identities = [],
    normals = [];
  for (const section of source.sections) {
    const cull =
      section.material.asset.passes.find((p) => p.name.toLowerCase() === 'forward')?.renderState
        ?.cullMode ?? 'back';
    assert(['none', 'back'].includes(cull));
    for (let at = section.indexOffset; at < section.indexOffset + section.indexCount; at += 3) {
      const t = indices.slice(at, at + 3).map((i) => positions[i]);
      triangles.push(t);
      normals.push(cross(sub(t[1], t[0]), sub(t[2], t[0])));
      identities.push({
        primitive: at / 3,
        material: section.material.id,
        cull,
        winding: Math.sign(determinant),
      });
    }
  }
  geometry.set(source.instance.instanceId, { triangles, identities, normals });
}
const queryFor = (instance, normal) => {
  const key = `${instance}:${normal.join(',')}`;
  if (!directionQueries.has(key)) {
    const source = geometry.get(instance);
    assert(source);
    const admitted = source.identities
      .map((_id, i) => i)
      .filter(
        (i) =>
          source.identities[i].cull === 'none' ||
          dot(source.normals[i], normal) * source.identities[i].winding > 0,
      );
    directionQueries.set(key, {
      query: createTriangleQuery(admitted.map((i) => source.triangles[i])),
      identities: admitted.map((i) => source.identities[i]),
      triangles: admitted.map((i) => source.triangles[i]),
    });
  }
  return directionQueries.get(key);
};
const rows = [];
for (let wi = 0; wi < model.works.length; wi += 4) {
  const name = gpu.works[wi].section,
    referenceName = name === 'complete-roster' ? 'world-probes' : name;
  const work = model.works[wi + 3],
    projections = initial(work, 6),
    settings = initial(work, 8),
    resolution = settings.getUint32(4, true);
  const diag = diagnosis.rows.find((r) => r.name === name),
    count = diag.perRay.length;
  assert.equal(reference.cohorts.find((r) => r.name === referenceName)?.rays, count);
  const sourceCheck = reference.sourceChecks.find((r) => r.name === referenceName);
  assert(sourceCheck?.initialSeedsByteExact && sourceCheck.identityMatchesCapturedGeometry);
  const cohort = cohorts.find((r) => r.name === referenceName);
  assert.equal(cohort.rays.length, count);
  const queryBytes = new Uint8Array(count * 48),
    queryFloats = new Float32Array(queryBytes.buffer),
    queryWords = new Uint32Array(queryBytes.buffer);
  cohort.rays.forEach((r, i) => {
    queryFloats.set([...r.origin, r.tMin, ...r.direction, r.tMax], i * 12);
    queryWords[i * 12 + 8] = r.mask;
  });
  const capturedQueries = initial(model.works[wi + 1], 2);
  assert.deepEqual(
    queryBytes,
    new Uint8Array(capturedQueries.buffer, capturedQueries.byteOffset, capturedQueries.byteLength),
    'reference cohort differs from association rays',
  );
  const input = view(await referenceBytes(`${referenceName}-inputs.bin`));
  const accumulation = view(await referenceBytes(`${referenceName}-accumulation.bin`));
  const surface = view(await referenceBytes(`${referenceName}-surfaces.bin`));
  assert.equal(input.byteLength, count * 224);
  assert.equal(accumulation.byteLength, count * 80);
  assert.equal(surface.byteLength, count * 96);
  const depthResource = model.resources.find(
    (r) => r.resourceId === work.bindings.find((b) => b.binding === 13).resourceId,
  );
  const desc = gpu.cardTextures.find((r) => r.id === depthResource.descriptor.sourceHandleId);
  assert(desc);
  const depthBytes = await read(associationPath, desc.file),
    depth = view(depthBytes),
    width = desc.desc.size.width;
  const seed = tape.bootstrap.find((r) => r.handleId === desc.id);
  assert.equal(seed.initialData.length, 1);
  assert.deepEqual(depthBytes, tape.blobs.find((b) => b.hash === seed.initialData[0].hash).bytes);
  const witnesses = new Map();
  const witnessFor = (card, texel) => {
    const key = `${card}:${texel}`;
    if (witnesses.has(key)) return witnesses.get(key);
    const b = card * 80,
      p = Array.from({ length: 16 }, (_, i) => projections.getFloat32(b + i * 4, true)),
      n = p.slice(12, 15),
      instance = projections.getUint32(b + 64, true);
    const xy = [
      (texel % width) - (card % (width / resolution)) * resolution,
      Math.floor(texel / width) - Math.floor(card / (width / resolution)) * resolution,
    ];
    assert(xy.every((v) => v >= 0 && v < resolution));
    const origin = p
      .slice(0, 3)
      .map(
        (v, a) =>
          v +
          ((p[4 + a] * (xy[0] + 0.5)) / resolution) * p[7] +
          ((p[8 + a] * (xy[1] + 0.5)) / resolution) * p[11],
      );
    const exact = queryFor(instance, n),
      hit = { primitive: -1, distance: 0, frontFace: false };
    const found = exact.query.trace(
      hit,
      origin,
      n.map((v) => -v),
      0,
      p[15],
    );
    const capturedDistance = depth.getFloat32(texel * 4, true) * p[15];
    // Numerical witness only. Raster edge ownership may differ from the ray at
    // the nominal texel center; every disagreement stays unresolved.
    const numericSlack = 32 * 2 ** -23 * Math.max(1, ...origin.map(Math.abs), p[15]);
    const delta = found ? Math.abs(hit.distance - capturedDistance) : null;
    let rasterDepthDelta = null;
    if (found && rasterGrid > 0) {
      const matrix = new Float32Array(16);
      matrix[15] = 1;
      for (let a = 0; a < 3; a++) {
        matrix[a * 4] = (2 * p[4 + a]) / p[7];
        matrix[a * 4 + 1] = (-2 * p[8 + a]) / p[11];
        matrix[a * 4 + 2] = -p[12 + a] / p[15];
      }
      matrix[12] = (-2 * dot(p.slice(0, 3), p.slice(4, 7))) / p[7] - 1;
      matrix[13] = (2 * dot(p.slice(0, 3), p.slice(8, 11))) / p[11] + 1;
      matrix[14] = dot(p.slice(0, 3), p.slice(12, 15)) / p[15];
      const projected = rasterTriangleWitness(
        exact.triangles[hit.primitive],
        { x: xy[0], y: xy[1], depth: capturedDistance / p[15] },
        { viewProjection: matrix, width: resolution, height: resolution, eye: origin },
        rasterGrid,
      );
      rasterDepthDelta = projected ? projected.error * p[15] : null;
    }
    const comparedDelta = rasterGrid > 0 ? rasterDepthDelta : delta;
    const row = {
      card,
      texel,
      instance,
      origin,
      direction: n.map((v) => -v),
      capturedDistance,
      geometricDistance: found ? hit.distance : null,
      numericSlack,
      delta,
      rasterDepthDelta,
      status: !found
        ? 'no-geometric-hit'
        : comparedDelta === null || comparedDelta > numericSlack
          ? 'raster-depth-disagreement'
          : 'depth-witness',
      identity: found ? exact.identities[hit.primitive] : null,
    };
    witnesses.set(key, row);
    return row;
  };
  const summary = {
    rays: count,
    referenceHits: 0,
    referenceMisses: 0,
    globalHits: 0,
    mappedRays: 0,
    mappedReferenceMisses: 0,
    unresolvedRays: 0,
    sameMaterialRays: 0,
    mixedMaterialRays: 0,
    differentMaterialRays: 0,
    sameMaterialMaxReferenceSupportWithin025m: 0,
    sameMaterialMaxReferenceSupportOver1m: 0,
    sameMaterialMaxReferenceSupportOver5m: 0,
    atLeastOneSameMaterialCandidate: 0,
    candidates: { total: 0, same: 0, mixed: 0, different: 0, unresolved: 0, referenceMiss: 0 },
    comparisons: Object.fromEntries(
      ['bothOpaque', 'maskInvolved'].map((key) => [
        key,
        { sameTexels: 0, differentTexels: 0, sameWeight: 0, differentWeight: 0 },
      ]),
    ),
  };
  const perRay = [],
    referenceDistances = [],
    globalDistances = [];
  const globalHitBytes = await read(associationPath, `${name}-query.bin`);
  const globalHits = view(globalHitBytes);
  assert.equal(globalHits.byteLength, count * 64);
  for (const ray of diag.perRay) {
    const i = ray.ray;
    assert.equal(i, perRay.length);
    assert.equal(ray.status, globalHits.getUint32(i * 64, true));
    assert.deepEqual(
      ray.position,
      [0, 1, 2].map((a) => globalHits.getFloat32(i * 64 + 32 + a * 4, true)),
      'diagnostic Global position differs from query readback',
    );
    assert.equal(accumulation.getUint32(i * 80 + 12, true), 1);
    assert.equal(
      accumulation.getUint32(i * 80 + 28, true),
      0,
      'incomplete or invalid material reference',
    );
    const hit = accumulation.getUint32(i * 80 + 64, true) !== 0xffffffff;
    summary[hit ? 'referenceHits' : 'referenceMisses']++;
    if (hit) assert.equal(surface.getUint32(i * 96 + 64, true), 1);
    const referenceHit = hit
      ? { material: input.getUint32(i * 224 + 208, true), position: [0, 0, 0] }
      : null;
    if (referenceHit) {
      referenceHit.position = [0, 1, 2].map((a) => input.getFloat32(i * 224 + 16 + a * 4, true));
      referenceHit.identity = [0, 1, 2, 3].map((a) =>
        accumulation.getUint32(i * 80 + 64 + a * 4, true),
      );
      referenceHit.t = input.getFloat32(i * 224 + 28, true);
    }
    const mapped = ray.actual.filter((c) => c.selected),
      candidates = [];
    summary.globalHits += Number(ray.status === 1);
    summary.mappedRays += Number(mapped.length > 0);
    let allSame = true,
      anySame = false,
      unresolved = false,
      maxReferenceDistance = 0,
      maxGlobalDistance = 0;
    for (const candidate of mapped) {
      const s = candidate.selected,
        support = s.texels.map((t, k) => {
          const witness = witnessFor(s.card, t);
          const capturedPosition = witness.origin.map(
            (v, a) => v + witness.direction[a] * witness.capturedDistance,
          );
          assert(
            Math.hypot(...sub(s.positions[k], capturedPosition)) < 1e-10,
            'diagnostic Card position differs from captured depth',
          );
          if (witness.status !== 'depth-witness') unresolved = true;
          const distanceToReference = referenceHit
            ? Math.hypot(...sub(s.positions[k], referenceHit.position))
            : null;
          const distanceToGlobalHit = Math.hypot(...sub(s.positions[k], ray.position));
          assert(Number.isFinite(distanceToGlobalHit));
          maxGlobalDistance = Math.max(maxGlobalDistance, distanceToGlobalHit);
          if (distanceToReference !== null)
            maxReferenceDistance = Math.max(maxReferenceDistance, distanceToReference);
          const sameMaterial =
            referenceHit && witness.status === 'depth-witness'
              ? witness.identity.material === referenceHit.material
              : null;
          allSame &&= sameMaterial === true;
          anySame ||= sameMaterial === true;
          return {
            texel: t,
            weight: s.weights[k],
            witness: `${s.card}:${t}`,
            distanceToReference,
            distanceToGlobalHit,
            sameMaterial,
            maskInvolved: Boolean(
              referenceHit &&
                (maskMaterials.has(referenceHit.material) ||
                  maskMaterials.has(witness.identity?.material)),
            ),
          };
        });
      const weight = { same: 0, different: 0, unresolved: 0 };
      for (const t of support) {
        weight[t.sameMaterial === null ? 'unresolved' : t.sameMaterial ? 'same' : 'different'] +=
          t.weight;
        if (t.sameMaterial !== null) {
          const bucket = summary.comparisons[t.maskInvolved ? 'maskInvolved' : 'bothOpaque'];
          bucket[t.sameMaterial ? 'sameTexels' : 'differentTexels']++;
          bucket[t.sameMaterial ? 'sameWeight' : 'differentWeight'] += t.weight;
        }
      }
      const agreement = !hit
        ? 'referenceMiss'
        : support.some((t) => t.sameMaterial === null)
          ? 'unresolved'
          : support.every((t) => t.sameMaterial)
            ? 'same'
            : support.some((t) => t.sameMaterial)
              ? 'mixed'
              : 'different';
      summary.candidates.total++;
      summary.candidates[agreement]++;
      candidates.push({ instance: candidate.instance, card: s.card, support, weight, agreement });
    }
    summary.atLeastOneSameMaterialCandidate += Number(
      candidates.some((c) => c.agreement === 'same'),
    );
    let status = 'no-card';
    if (mapped.length) {
      if (!hit) {
        summary.mappedReferenceMisses++;
        status = 'reference-miss';
      } else if (unresolved) {
        summary.unresolvedRays++;
        status = 'unresolved';
      } else if (allSame) {
        summary.sameMaterialRays++;
        status = 'same-material';
        summary.sameMaterialMaxReferenceSupportWithin025m += Number(maxReferenceDistance <= 0.25);
        summary.sameMaterialMaxReferenceSupportOver1m += Number(maxReferenceDistance > 1);
        summary.sameMaterialMaxReferenceSupportOver5m += Number(maxReferenceDistance > 5);
      } else if (anySame) {
        summary.mixedMaterialRays++;
        status = 'mixed-material';
      } else {
        summary.differentMaterialRays++;
        status = 'different-material';
      }
      if (hit) referenceDistances.push(maxReferenceDistance);
      globalDistances.push(maxGlobalDistance);
    }
    perRay.push({
      ray: i,
      globalStatus: ray.status,
      status,
      reference: referenceHit,
      candidates,
      globalPosition: ray.position,
      maxSupportDistanceToReference: hit && mapped.length ? maxReferenceDistance : null,
      maxSupportDistanceToGlobalHit: mapped.length ? maxGlobalDistance : null,
    });
  }
  const distribution = (distances) => {
    distances.sort((a, b) => a - b);
    return {
      samples: distances.length,
      p50: distances[Math.floor(distances.length * 0.5)] ?? null,
      p95: distances[Math.ceil(distances.length * 0.95) - 1] ?? null,
      max: distances.at(-1) ?? null,
    };
  };
  summary.maxSupportDistanceToReference = distribution(referenceDistances);
  summary.maxSupportDistanceToGlobalHit = distribution(globalDistances);
  summary.witnesses = Object.fromEntries(
    ['depth-witness', 'no-geometric-hit', 'raster-depth-disagreement'].map((s) => [
      s,
      [...witnesses.values()].filter((w) => w.status === s).length,
    ]),
  );
  rows.push({
    name,
    globalHitSha256: sha(globalHitBytes),
    summary,
    witnesses: Object.fromEntries(witnesses),
    perRay,
  });
  console.log(JSON.stringify({ name, summary }, null, 2));
}
await writeFile(
  reportPath,
  JSON.stringify(
    {
      scope:
        'Geometric Card texel witnesses versus shared-material first hits. No alpha test in Card proxy; reference uses authored MASK with its declared ray footprint. Support distances separately measure texel-to-Global-hit and texel-to-material-reference in world units; local proximity does not establish correct ray visibility. Numerical depth agreement does not prove identical primitives at raster boundaries or shading equality.',
      rasterGrid,
      maskMaterials: [...maskMaterials],
      referenceSha256: sha(await read(referencePath, 'gpu.json')),
      cardSha256: sha(cardBytes),
      tapeSha256: sha(tapeBytes),
      rows,
    },
    null,
    2,
  ),
);
