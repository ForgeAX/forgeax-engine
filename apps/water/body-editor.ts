import type { App } from '@forgeax/engine/app';
import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';
import { createRuntimePackPublication } from '@forgeax/engine/pack/runtime';
import {
  type AssetHandle,
  err,
  type MeshAsset,
  ok,
  type WaterBodyAsset,
} from '@forgeax/engine/types';
import { buildWaterPackOutputs } from '@forgeax/engine/water';
import { geometryMeshReferences } from './geometry-publication';

const cookedFields = new Set([
  'riverSegmentMeshGuids',
  'visibleMeshGuid',
  'waterInfoMeshGuid',
  'dilatedWaterInfoMeshGuid',
  'brushShapeMeshGuid',
  'collisionMeshGuid',
  'waterGeometryVersion',
  'oceanCenterM',
  'geometryAuthoringWorldMatrixM',
  'geometrySnapshot',
]);

/** A demanded edit replaces the existing Pack Body/Mesh closure through its asset owner. */
export function waterBodyEditor(
  assets: NonNullable<App['assets']>,
  handle: AssetHandle<'water-body', WaterBodyAsset>,
  accepted: () => void,
  rejected: (error: unknown) => void,
) {
  let sequence = 0;
  return (value: Record<string, unknown>) => {
    const request = ++sequence;
    const priorRevision = assets.revision(handle).unwrap();
    void (async () => {
      const origin = assets.source(handle).unwrap();
      if (!origin) throw new Error('WaterBody editing requires its admitted Pack source identity');
      const catalog = (await assets.enumerateCatalog()).unwrap();
      const originalRow = catalog.find((row) => row.guid === origin.guid);
      const sourceKey = originalRow?.sourceKey;
      const packageId = PackageId.parse(originalRow?.packageId ?? '');
      if (
        !sourceKey ||
        !packageId.ok ||
        AssetGuid.format(AssetGuid.derive(packageId.value, sourceKey)) !== origin.guid
      )
        throw new Error('WaterBody editing requires the original Pack packageId and sourceKey');
      const source = Object.fromEntries(
        Object.entries(value).filter(([key]) => !cookedFields.has(key)),
      );
      const matrix = value.geometryAuthoringWorldMatrixM as readonly number[] | undefined;
      const output = (
        await buildWaterPackOutputs(
          { [sourceKey]: source },
          {
            packageId: packageId.value,
            ...(matrix ? { bodyWorldTransformsM: { [sourceKey]: matrix } } : {}),
            readByGuid: async (guid) => {
              const id = AssetGuid.format(guid);
              const row = catalog.find((entry) => entry.guid === id);
              if (row?.kind === 'water-wave-set') {
                const loaded = await assets.load(id, 'water-wave-set');
                if (!loaded.ok) return err(loaded.error);
                try {
                  return ok(assets.read(loaded.value).unwrap());
                } finally {
                  assets.release(loaded.value).unwrap();
                }
              }
              const loaded = await assets.load(id, 'mesh');
              if (!loaded.ok) return err(loaded.error);
              try {
                return ok(assets.read(loaded.value).unwrap());
              } finally {
                assets.release(loaded.value).unwrap();
              }
            },
          },
        )
      ).unwrap();
      if (request !== sequence) return;
      const next = output[sourceKey] as WaterBodyAsset;
      const references = [
        ...new Set(
          [
            ...(next.riverSegmentMeshGuids ?? []),
            next.visibleMeshGuid,
            next.waterInfoMeshGuid,
            next.dilatedWaterInfoMeshGuid,
            next.brushShapeMeshGuid,
            next.collisionMeshGuid,
            next.surfaceMaterialGuid,
            next.zoneGuid,
            next.waveSetGuid,
            next.customMeshOverrideGuid,
            next.collision.meshGuid,
            next.riverToLakeTransitionMaterialGuid,
            next.riverToOceanTransitionMaterialGuid,
            next.waterInfoMaterialGuid,
            next.lodMaterialGuid,
            next.underwaterPostProcessMaterialGuid,
          ].filter((guid): guid is string => typeof guid === 'string'),
        ),
      ];
      const packageUrl = `https://water-edit.invalid/${origin.guid}/${request}.pack.json`;
      const sourcePath = originalRow?.sourcePath ?? 'runtime-water-body.pack.ts';
      const prepared = createRuntimePackPublication({
        scopeId: origin.publication?.scopeId ?? originalRow?.packageId ?? 'water-body-edit',
        sourcePath,
        sourceRevision: `parameter-${request}-${priorRevision}`,
        packageUrl,
        sourceKeys: new Map(
          Object.keys(output).map((key) => [
            AssetGuid.format(AssetGuid.derive(packageId.value, key)),
            key,
          ]),
        ),
        pack: {
          assets: Object.entries(output).map(([key, payload]) => ({
            guid: AssetGuid.format(AssetGuid.derive(packageId.value, key)),
            kind: payload.kind,
            payload,
            refs:
              key === sourceKey
                ? references
                : payload.kind === 'mesh'
                  ? geometryMeshReferences(payload as MeshAsset)
                  : [],
            artifacts: {},
          })),
        },
      });
      const generated = new Set(prepared.pack.assets.map((asset) => asset.guid));
      const retained = new Set<string>();
      const retain = (guid: string) => {
        if (generated.has(guid) || retained.has(guid)) return;
        retained.add(guid);
        const row = catalog.find((entry) => entry.guid === guid);
        if (!row) throw new Error(`Missing retained WaterBody dependency ${guid}`);
        for (const ref of row.refs ?? []) retain(ref);
        for (const ref of row.publication?.outputs.find((output) => output.guid === guid)?.refs ??
          [])
          retain(ref);
        for (const evidence of row.publication?.externalEvidence ?? []) retain(evidence.guid);
      };
      for (const asset of prepared.pack.assets) for (const guid of asset.refs) retain(guid);
      const dependencies = new Map(
        [...retained].map((guid) => {
          const row = catalog.find((entry) => entry.guid === guid);
          if (!row) throw new Error(`Missing retained WaterBody dependency ${guid}`);
          return [guid, { row }] as const;
        }),
      );
      const rows = prepared.pack.assets.map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        refs: asset.refs,
        sourcePath,
        sourceKey:
          Object.keys(output).find(
            (key) => AssetGuid.format(AssetGuid.derive(packageId.value, key)) === asset.guid,
          ) ?? sourceKey,
        packageId: PackageId.format(packageId.value),
        packageUrl,
        publication: prepared.publication,
      }));
      (
        await assets.preparePublication(
          rows,
          async () => new Response('', { status: 404 }),
          undefined,
          { pack: prepared.pack, dependencies },
        )
      ).unwrap();
      if (request !== sequence) return;
      assets
        .adoptPreparedContent(prepared.pack, [], () => {
          if (assets.revision(handle).unwrap() !== priorRevision)
            throw new Error('WaterBody changed while its parameter replacement was prepared');
        })
        .unwrap();
      accepted();
    })().catch(rejected);
  };
}
