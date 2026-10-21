import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Skylight } from '@forgeax/engine-render';
import type { Renderer } from '@forgeax/engine-render';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { AssetHandle, EquirectAsset } from '@forgeax/engine-types';
import type { Context } from '@forgeax/engine-plugin';

export const GAME_DEFAULT_HDR_GUID = '81eec382-392f-5a93-8998-0ecf11ef7990';
const MISSING_GUID = '00000000-0000-4000-8000-000000000000';
export const GAME_DEFAULT_ASSET_EVIDENCE_KEY = '__forgeaxGameDefaultAssetEvidence';

type AssetLoadWitness = {
  readonly ok: boolean;
  readonly code?: string;
  readonly kind?: string;
  readonly width?: number;
  readonly height?: number;
  readonly format?: string;
  readonly colorSpace?: string;
};

export type GameDefaultAssetEvidence = {
  readonly ready: Promise<void>;
  readonly reload: () => Promise<AssetLoadWitness>;
  readonly setIntensity: (intensity: number) => void;
  readonly reset: () => void;
  readonly probeMissing: () => Promise<{ readonly ok: boolean; readonly code?: string }>;
  readonly snapshot: () => {
    readonly guid: string;
    readonly name: string;
    readonly load: AssetLoadWitness;
    readonly reloads: number;
    readonly intensity: number | null;
    readonly features: readonly string[];
  };
};

type AssetContentEvidenceArgs = {
  readonly context: Context;
  readonly assets: AssetRegistry | undefined;
  readonly renderer: Renderer | undefined;
  readonly world: World;
  readonly skylight: EntityHandle | undefined;
};

function witnessFromPayload(payload: EquirectAsset): AssetLoadWitness {
  return {
    ok: true,
    kind: payload.kind,
    width: payload.width,
    height: payload.height,
    format: payload.format,
    colorSpace: payload.colorSpace,
  };
}

function parseGuid(text: string): ReturnType<typeof AssetGuid.parse> {
  return AssetGuid.parse(text);
}

export function installAssetContentEvidence(args: AssetContentEvidenceArgs): void {
  if (args.assets === undefined || args.renderer === undefined || typeof location === 'undefined') return;
  if (!new URLSearchParams(location.search).has('asset-evidence')) return;

  const guidResult = parseGuid(GAME_DEFAULT_HDR_GUID);
  const missingResult = parseGuid(MISSING_GUID);
  if (!guidResult.ok || !missingResult.ok) return;
  const assets = args.assets;
  const guid = guidResult.value;
  const missingGuid = missingResult.value;
  let latest: AssetLoadWitness = { ok: false, code: 'not-started' };
  let reloads = 0;

  let equirect: AssetHandle<'equirect'> | undefined;
  let disposed = false;
  const load = async (): Promise<void> => {
    const result = await assets.load(guid, 'equirect');
    if (!result.ok) {
      latest = { ok: false, code: result.error.code };
      return;
    }
    if (disposed) {
      assets.release(result.value).unwrap();
      return;
    }
    equirect = result.value;
    latest = witnessFromPayload(assets.read(equirect).unwrap());
    if (args.skylight !== undefined) args.world.set(args.skylight, Skylight, { equirect, intensity: 0.25 }).unwrap();
  };

  const ready = load();
  const reload = async (): Promise<AssetLoadWitness> => {
    await ready;
    if (disposed || equirect === undefined) return latest;
    reloads += 1;
    const result = await assets.reload(equirect, { conflict: 'reject' });
    if (disposed) return latest;
    latest = result.ok ? witnessFromPayload(assets.read(equirect).unwrap()) : { ok: false, code: result.error.code };
    return latest;
  };
  const setIntensity = (intensity: number): void => {
    if (args.skylight === undefined) return;
    args.world.set(args.skylight, Skylight, { intensity });
  };
  const reset = (): void => setIntensity(0.25);
  const probeMissing = async (): Promise<{ readonly ok: boolean; readonly code?: string }> => {
    const result = await assets.load(missingGuid, 'equirect');
    if (!result.ok) return { ok: false, code: result.error.code };
    assets.release(result.value).unwrap();
    return { ok: true };
  };
  const evidence: GameDefaultAssetEvidence = {
    ready,
    reload,
    setIntensity,
    reset,
    probeMissing,
    snapshot: () => {
      const skylight = args.skylight === undefined ? null : args.world.get(args.skylight, Skylight);
      return {
        guid: GAME_DEFAULT_HDR_GUID,
        name: args.assets!.catalogEntry(GAME_DEFAULT_HDR_GUID)?.name ?? GAME_DEFAULT_HDR_GUID,
        load: latest,
        reloads,
        intensity: skylight?.ok ? skylight.value.intensity : null,
        features: [...args.renderer!.inspect().features],
      };
    },
  };
  const host = globalThis as unknown as Record<string, unknown>;
  host[GAME_DEFAULT_ASSET_EVIDENCE_KEY] = evidence;
  args.context.effect(
    () => () => {
      disposed = true;
      if (equirect !== undefined) assets.release(equirect).unwrap();
      if (host[GAME_DEFAULT_ASSET_EVIDENCE_KEY] === evidence) delete host[GAME_DEFAULT_ASSET_EVIDENCE_KEY];
    },
    'game-default/asset-evidence',
  );
}
