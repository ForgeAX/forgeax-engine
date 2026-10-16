import { parseGltf } from '@forgeax/engine/gltf';
import { rejectLoader, skinnedGltf } from '../../features/asset-formats/fixtures/gltf-source';
import { errorCode, guid } from '../../features/asset-formats/fixtures/memory-pack';
import { defineFeature } from '../../lab/feature';
import { importGltf } from './gltf-importer';

const SKIN_SUB_ASSETS = [
  { guid: guid(0x501), sourceIndex: 0, kind: 'skeleton', sourceKey: 'skeleton' },
  { guid: guid(0x502), sourceIndex: 0, kind: 'skin', sourceKey: 'skin' },
  { guid: guid(0x503), sourceIndex: 0, kind: 'animation-clip', sourceKey: 'animation-clip:Slide' },
];

export default defineFeature({
  title: 'glTF skin/animation',
  catalog: 'glTF skin/animation',
  kind: 'headless',
  summary:
    'An in-code one-joint skinned glTF imports into skeleton, skin and animation-clip assets; joints are stored as name paths that the runtime resolves after spawn, and valid CUBICSPLINE tangent triplets survive parsing.',
  expect:
    'The skin payload names its skeleton GUID and joint path root/joint, the skeleton carries conservative animated bounds covering x in [<=1, >=5], the clip is produced, STEP and valid CUBICSPLINE parse, while missing tangent triplets fail with gltf-animation-sampler-invalid.',
  async run(checks) {
    const imported = await importGltf(skinnedGltf(), SKIN_SUB_ASSETS);
    checks.ok('runImport ok', imported.ok, imported.ok ? undefined : imported.code);
    if (imported.ok) {
      const byGuid = new Map(imported.assets.map((asset) => [asset.guid, asset]));
      checks.equal('skin payload', byGuid.get(guid(0x502))?.payload, {
        kind: 'skin',
        skeletonGuid: guid(0x501),
        jointPaths: ['root/joint'],
      });
      const bounds = (
        byGuid.get(guid(0x501))?.payload as { readonly bounds?: ArrayLike<number> } | undefined
      )?.bounds;
      checks.ok(
        'skeleton bounds enclose the animated joint',
        bounds !== undefined &&
          (bounds[0] ?? 9) <= 1 &&
          (bounds[3] ?? 0) >= 5 &&
          (bounds[4] ?? 0) >= 2,
        bounds === undefined ? 'missing' : Array.from(bounds).join(','),
      );
      const clip = byGuid.get(guid(0x503));
      checks.equal('animation clip produced', clip?.kind, 'animation-clip');
    }

    const step = await parseGltf(skinnedGltf('STEP'), rejectLoader, 'step.gltf');
    checks.ok('STEP interpolation parses', step.ok, step.ok ? undefined : step.error.code);
    checks.equal('one clip parsed', step.ok ? step.value.animationClips.length : undefined, 1);
    const cubic = await parseGltf(skinnedGltf('CUBICSPLINE'), rejectLoader, 'cubic.gltf');
    checks.ok(
      'CUBICSPLINE tangent triplets parse',
      cubic.ok,
      cubic.ok ? undefined : cubic.error.code,
    );
    const sampler = cubic.ok ? cubic.value.animationClips[0]?.channels[0]?.sampler : undefined;
    checks.equal('CUBICSPLINE is retained', sampler?.interpolation, 'CUBICSPLINE');
    checks.equal('six VEC3 tangent/value records are retained', sampler?.output.length, 18);
    const malformed = skinnedGltf('LINEAR');
    (malformed.animations as { samplers: { interpolation: string }[] }[])[0]?.samplers.forEach(
      (sampler) => {
        sampler.interpolation = 'CUBICSPLINE';
      },
    );
    const invalid = await parseGltf(malformed, rejectLoader, 'missing-tangents.gltf');
    checks.equal(
      'CUBICSPLINE without tangent triplets is rejected',
      invalid.ok ? 'ok' : errorCode(invalid.error),
      'gltf-animation-sampler-invalid',
    );
  },
});
