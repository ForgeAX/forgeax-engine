import {
  ALL_FILTER_FAMILIES,
  FILTERABLE_ASSET_KINDS,
  assetFileFamilyOf,
  compareItems,
  dirOfPath,
  matchesSearch,
} from './format';
import type {
  CBAsset,
  CBFile,
  CBFilter,
  CBFilterFamily,
  CBFolder,
  CBKindFilter,
  CBSortDir,
  CBSortKey,
  CBSortState,
  CBViewItem,
} from './types';

export function translatedOrFallback(
  t: (key: string) => string,
  key: string,
  fallbackKey: string,
): string {
  const label = t(key);
  return label === key ? t(fallbackKey) : label;
}

export function assetKindLabel(
  kind: string,
  t: (key: string) => string,
): string {
  return translatedOrFallback(
    t,
    `contentBrowser.assetKinds.${kind}`,
    'contentBrowser.assetKinds.default',
  );
}

export function buildFamilyFilters(
  activeFamilies: ReadonlySet<CBFilterFamily>,
  t: (key: string) => string,
): CBFilter[] {
  return ALL_FILTER_FAMILIES.map((family) => ({
    id: `family:${family}`,
    family,
    label: translatedOrFallback(
      t,
      family === 'dir' ? 'contentBrowser.fileKinds.dir' : `contentBrowser.fileKinds.${family}`,
      'contentBrowser.fileKinds.other',
    ),
    active: activeFamilies.has(family),
  }));
}

export function buildKindFilters(
  activeKinds: ReadonlySet<string>,
  t: (key: string) => string,
): CBKindFilter[] {
  return FILTERABLE_ASSET_KINDS.map((kind) => ({
    id: `kind:${kind}`,
    kind,
    label: assetKindLabel(kind, t),
    active: activeKinds.has(kind),
  }));
}

export function toggleFilterId(
  filterId: string,
  activeFamilies: ReadonlySet<CBFilterFamily>,
  activeKinds: ReadonlySet<string>,
): { families: Set<CBFilterFamily>; kinds: Set<string> } {
  const [scope, value] = filterId.split(':');
  const families = new Set(activeFamilies);
  const kinds = new Set(activeKinds);
  if (scope === 'kind' && value) {
    if (kinds.has(value)) kinds.delete(value);
    else kinds.add(value);
    return { families, kinds };
  }
  const family = value as CBFilterFamily;
  if (families.has(family)) families.delete(family);
  else families.add(family);
  return { families, kinds };
}

export function fileKindLabel(
  file: Pick<CBFile, 'isAssetPackage' | 'family'>,
  t: (key: string) => string,
): string {
  return file.isAssetPackage
    ? t('contentBrowser.fileKinds.assetPackage')
    : translatedOrFallback(
      t,
      `contentBrowser.fileKinds.${file.family}`,
      'contentBrowser.fileKinds.other',
    );
}

export function deriveViewItems({
  folders,
  files,
  currentPath,
  searchQuery,
  activeFamilies,
  activeKinds,
  sortState,
  expandedPacks,
  withKindLabel,
  revealPath,
}: {
  folders: readonly CBFolder[];
  files: readonly CBFile[];
  currentPath: string;
  searchQuery: string;
  activeFamilies: ReadonlySet<CBFilterFamily>;
  activeKinds: ReadonlySet<string>;
  sortState: CBSortState;
  expandedPacks: ReadonlySet<string>;
  withKindLabel: (file: CBFile) => CBFile;
  revealPath?: string | null;
}): {
  foldersInPath: CBFolder[];
  filesInPath: CBFile[];
  viewItems: CBViewItem[];
  searchActive: boolean;
  kindFilterActive: boolean;
} {
  const query = searchQuery.trim().toLowerCase();
  const searchActive = query !== '';
  const kindFilterActive = activeKinds.size > 0;
  const labeledFiles = files.map(withKindLabel);
  const revealed = labeledFiles.find(file => file.path === revealPath && dirOfPath(file.path) === currentPath);
  const matchesSourceFamily = (file: CBFile) => activeFamilies.has(file.family)
    || (file.isAssetPackage && activeFamilies.has('pack'));
  const matchesAssetFamily = (asset: CBAsset) => {
    const family = assetFileFamilyOf(asset.kind);
    return family !== undefined && activeFamilies.has(family);
  };

  const foldersInPath = folders
    .filter((folder) => dirOfPath(folder.path) === currentPath)
    .filter(() => activeFamilies.size === 0 || activeFamilies.has('dir'))
    .filter((folder) => {
      if (!query) return true;
      const prefix = `${folder.path}/`;
      return matchesSearch(folder, query)
        || labeledFiles.some((file) => file.path.startsWith(prefix) && matchesSearch(file, query));
    })
    .toSorted((a, b) => compareItems(a, b, 'name', sortState.dir));

  const filesInPath = labeledFiles
    .filter((file) => dirOfPath(file.path) === currentPath)
    .filter((file) => file === revealed || activeFamilies.size === 0
      || matchesSourceFamily(file) || file.assets.some(matchesAssetFamily))
    .filter((file) => file === revealed || !query || matchesSearch(file, query))
    .toSorted((a, b) => compareItems(a, b, sortState.key, sortState.dir));

  if (kindFilterActive) {
    const seen = new Set<string>();
    const out: CBViewItem[] = [];
    for (const file of filesInPath) {
      if (file === revealed) continue;
      let addedHtml = false;
      for (const asset of file.assets) {
        if (seen.has(asset.guid) || !activeKinds.has(asset.kind)) continue;
        if (activeFamilies.size > 0 && !matchesAssetFamily(asset)
          && !(file.isAssetPackage && activeFamilies.has('pack'))
          && !(matchesSourceFamily(file) && !file.isAssetPackage)) continue;
        if (query && !matchesSearch(asset, query) && !file.name.toLowerCase().includes(query)) continue;
        seen.add(asset.guid);
        if (file.name.toLowerCase().endsWith('.html')) {
          if (!addedHtml) out.push(file);
          addedHtml = true;
        } else out.push(asset);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    const revealedItems = revealed
      ? revealed.assets.length === 1 ? [...revealed.assets] : [revealed, ...revealed.assets]
      : [];
    return { foldersInPath: [], filesInPath, viewItems: [...revealedItems, ...out], searchActive, kindFilterActive };
  }

  const items: CBViewItem[] = [...foldersInPath];
  for (const file of filesInPath) {
    if (activeFamilies.size > 0 && file !== revealed) {
      const sourceMatchesSearch = !query || file.name.toLowerCase().includes(query) || file.path.toLowerCase().includes(query);
      const searchedAssets = file.assets.filter((asset) => sourceMatchesSearch || matchesSearch(asset, query));
      const matchingAssets = searchedAssets.filter(matchesAssetFamily);
      const sourceMatches = matchesSourceFamily(file);
      if (file.name.toLowerCase().endsWith('.html') && (sourceMatches || matchingAssets.length > 0)) {
        items.push(file);
        continue;
      }
      if (file.isAssetPackage && sourceMatches
        && (sourceMatchesSearch || matchingAssets.length > 0 || (activeFamilies.has('pack') && searchedAssets.length > 0))) {
        items.push(file);
        if (activeFamilies.has('pack') && (searchActive || expandedPacks.has(file.path))) {
          items.push(...searchedAssets);
        } else {
          items.push(...matchingAssets);
        }
      } else if (matchingAssets.length > 0) {
        items.push(...matchingAssets);
      } else if (sourceMatches && sourceMatchesSearch) {
        items.push(file.assets.length === 1 && !file.name.toLowerCase().endsWith('.html') ? file.assets[0]! : file);
      } else if (sourceMatches && !file.isAssetPackage) {
        items.push(...searchedAssets);
      }
      continue;
    }
    if (file.assets.length === 0) {
      items.push(file);
      continue;
    }
    if (file.assets.length === 1 && !file.name.toLowerCase().endsWith('.html')) {
      items.push(...file.assets);
      continue;
    }
    items.push(file);
    if (searchActive || expandedPacks.has(file.path)) items.push(...file.assets);
  }
  return { foldersInPath, filesInPath, viewItems: items, searchActive, kindFilterActive };
}

export function nextSortState(current: CBSortState, key: CBSortKey): CBSortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

export function setSortDir(current: CBSortState, dir: CBSortDir): CBSortState {
  return current.dir === dir ? current : { ...current, dir };
}
