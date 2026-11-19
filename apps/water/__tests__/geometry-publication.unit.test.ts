import { createBoxGeometry } from '@forgeax/engine/geometry';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import { expect, it } from 'vitest';
import { validateAssetReferences } from '../../../packages/assets-runtime/src/prepare-payload';
import { geometryMeshReferences } from '../geometry-publication';

it('retains the generated default material edge for private Pack admission', () => {
  const material = '00000000-0000-7000-8000-000000000001';
  const parsed = AssetGuid.parse(material);
  if (!parsed.ok) throw parsed.error;
  const mesh = {
    ...createBoxGeometry(2, 1, 3).unwrap(),
    materialSlots: [{ slotName: 'Default', defaultMaterial: parsed.value }],
  };
  const kind = (guid: string) => (guid === material ? 'material' : undefined);
  expect(validateAssetReferences(mesh, 'mesh-fixture', [], kind)?.code).toBe('asset-parse-failed');
  expect(
    validateAssetReferences(
      mesh,
      'mesh-fixture',
      geometryMeshReferences(mesh).map((guid) => ({ guid })),
      kind,
    ),
  ).toBeUndefined();
});
