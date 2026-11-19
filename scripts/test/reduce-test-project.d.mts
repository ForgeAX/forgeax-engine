import type quality from './render-quality.json';

type AssetLibraries = { readonly assetLibraries?: readonly string[] };

export function withoutEngineContentLibrary<T extends AssetLibraries>(
  manifest: T,
): Omit<T, keyof AssetLibraries> & AssetLibraries;

export function reduceTestProject(
  root: string,
  overrides?: Partial<typeof quality> & { readonly omitEngineContent?: boolean },
): Promise<void>;
