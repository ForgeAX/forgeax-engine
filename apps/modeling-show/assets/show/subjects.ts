import { AssetGuid, PackageId } from '@forgeax/engine/pack/guid';
import type { AssetHandle } from '@forgeax/engine/types';
import { COMMON_CONTROLS, parseControls, type ShowControl } from './controls.ts';
import { captureHistory, type HistoryStage } from './history.ts';
import type { ShowSubject } from './show.ts';

/**
 * A Show program in Pack terms: each subject lists the Pack outputs it assembles (by
 * packageId and source key), the material slots its Packs publish, and the build
 * stages its history timeline runs through. A whole machine (F1 mech-gt S8) is one
 * subject with several Packs, one transformation clip and every build stage.
 */
export interface ShowSubjectSource {
  readonly name: string;
  /** A Pack that lists no scenes or meshes contributes every mesh it publishes, and its materials beside the listed ones (`discoverOutputs`). */
  readonly packs: readonly {
    readonly packageId: string;
    readonly scenes?: readonly string[];
    readonly meshes?: readonly string[];
    /** Material source keys by slot name. */
    readonly materials?: Readonly<Record<string, string>>;
  }[];
  readonly xray?: readonly string[];
  readonly history?: readonly HistoryStage[];
  /** Looks of material slots no Pack publishes a material for (linear color). */
  readonly palette?: ShowSubject['palette'];
  /** Slots that take a program look (by name) in the clean finish, the subject's default. */
  readonly clean?: Readonly<Record<string, string>>;
  /** One line about the subject shown under the caption. */
  readonly legend?: string;
  /** Where the geometry comes from (Pack, build function and stage), shown on the page and recorded by the runner. */
  readonly source?: string;
  /** Debug panel controls (default `COMMON_CONTROLS`, each where it applies). */
  readonly controls?: readonly ShowControl[];
}

export type ShowAssetKind = 'scene' | 'mesh' | 'material';

/**
 * Fill every Pack that lists no outputs with all its published meshes (LOD levels excluded)
 * and its `material/<slot>` materials, from the realm's Catalog entries. A gallery subject
 * names only its Packs; slots without a material take the Show palette.
 */
export function discoverOutputs(
  sources: readonly ShowSubjectSource[],
  entries: readonly { readonly guid: string; readonly kind: string; readonly sourceKey?: string }[],
): ShowSubjectSource[] {
  return sources.map((source) => ({
    ...source,
    packs: source.packs.map((pack) => {
      if (pack.scenes !== undefined || pack.meshes !== undefined) return pack;
      const own = entries.filter(
        (entry) => entry.sourceKey !== undefined && packGuid(pack.packageId, entry.sourceKey) === entry.guid.toLowerCase(),
      );
      const keys = (kind: string) => own.filter((entry) => entry.kind === kind).map((entry) => entry.sourceKey as string).sort();
      return {
        ...pack,
        meshes: keys('mesh').filter((key) => !/\/lod\d+$/.test(key)),
        materials: {
          ...Object.fromEntries(
            keys('material')
              .filter((key) => key.startsWith('material/'))
              .map((key) => [key.slice('material/'.length), key]),
          ),
          ...pack.materials,
        },
      };
    }),
  }));
}

const keyName = (key: string) => key.split('/').pop() ?? key;

export function packGuid(packageId: string, sourceKey: string): string {
  const id = PackageId.parse(packageId);
  if (!id.ok) throw id.error;
  return AssetGuid.format(AssetGuid.derive(id.value, sourceKey));
}

/**
 * Resolve subject sources to Show subjects: Pack outputs through the realm's loader
 * (`assets.load` in a game, published handles in the Dawn harness) and histories by
 * re-running their build stages.
 */
export async function resolveSubjects(
  sources: readonly ShowSubjectSource[],
  load: (guid: string, kind: ShowAssetKind) => Promise<AssetHandle>,
  looks: Readonly<Record<string, AssetHandle<'material'>>> = {},
): Promise<ShowSubject[]> {
  const subjects: ShowSubject[] = [];
  for (const source of sources) {
    const scenes: AssetHandle<'scene'>[] = [];
    const meshes: { handle: AssetHandle<'mesh'>; name: string }[] = [];
    const materials: Record<string, AssetHandle<'material'>> = {};
    for (const pack of source.packs) {
      for (const key of pack.scenes ?? []) scenes.push((await load(packGuid(pack.packageId, key), 'scene')) as AssetHandle<'scene'>);
      for (const key of pack.meshes ?? [])
        meshes.push({ handle: (await load(packGuid(pack.packageId, key), 'mesh')) as AssetHandle<'mesh'>, name: keyName(key) });
      for (const [slot, key] of Object.entries(pack.materials ?? {})) {
        materials[slot] = (await load(packGuid(pack.packageId, key), 'material')) as AssetHandle<'material'>;
      }
    }
    const controls = parseControls(source.controls ?? COMMON_CONTROLS);
    if (!controls.ok) throw new Error(`Show subject ${source.name}: ${controls.error.code} at ${controls.error.index}`);
    const bake = controls.value.find((control) => control.kind === 'bake');
    const plainSlot =
      bake === undefined
        ? undefined
        : source.packs.flatMap((pack) => Object.entries(pack.materials ?? {})).find(([, key]) => key === bake.plain)?.[0];
    if (bake !== undefined && (plainSlot === undefined || materials[plainSlot] === undefined))
      throw new Error(`Show subject ${source.name}: the bake plain material ${bake.plain} is not among its Pack materials`);
    subjects.push({
      name: source.name,
      controls: controls.value,
      ...(bake === undefined
        ? {}
        : { bake: { high: keyName(bake.high), low: keyName(bake.low), plain: materials[plainSlot as string] as AssetHandle<'material'> } }),
      scenes,
      meshes,
      materials,
      ...(source.xray === undefined ? {} : { xray: source.xray }),
      ...(source.palette === undefined ? {} : { palette: source.palette }),
      ...(source.legend === undefined ? {} : { legend: source.legend }),
      ...(source.source === undefined ? {} : { source: source.source }),
      ...(source.clean === undefined
        ? {}
        : {
            clean: Object.fromEntries(
              Object.entries(source.clean).flatMap(([slot, look]) => (looks[look] === undefined ? [] : [[slot, looks[look]]])),
            ),
          }),
      ...(source.history === undefined ? {} : { history: await captureHistory(source.history) }),
    });
  }
  return subjects;
}
