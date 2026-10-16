export type CBFileFamily =
  | 'code'
  | 'config'
  | 'doc'
  | 'scene'
  | 'pack'
  | 'meta'
  | 'image'
  | 'audio'
  | 'model'
  | 'font'
  | 'ui'
  | 'data'
  | 'other';

export type CBFilterFamily = CBFileFamily | 'dir';
export type CBViewMode = 'grid' | 'list' | 'column';
export type CBSortKey = 'name' | 'kind' | 'packModifiedAt' | 'estimatedSize';
export type CBSortDir = 'asc' | 'desc';
export type CBFilePreviewMode = 'assets' | 'source';

export interface CBFolder {
  type: 'folder';
  path: string;
  name: string;
  childCount: number;
}

export interface CBAsset {
  type: 'asset';
  guid: string;
  kind: string;
  name: string;
  packPath: string;
  packIndex?: number;
  payload?: Record<string, unknown>;
  refs?: string[];
  estimatedSize?: number;
  packModifiedAt?: number;
  publicationId?: string;
  lifecycle?: 'missing' | 'cooking' | 'current' | 'stale' | 'failed';
}

export interface CBFile {
  type: 'file';
  path: string;
  diskPath: string;
  name: string;
  family: CBFileFamily;
  assets: CBAsset[];
  isAssetPackage: boolean;
  kindLabel: string;
  sourcePreview?: string;
  estimatedSize?: number;
  packModifiedAt?: number;
  diagnostic?: { code: string; hint: string };
}

export type CBViewItem = CBFolder | CBFile | CBAsset;

export interface PreviewFileInfo {
  path: string;
  kind: string;
  mime: string;
  size: number;
  mtime: number;
  content?: string;
  dataUrl?: string;
}

export interface CBFilter {
  id: string;
  family: CBFilterFamily;
  label: string;
  active: boolean;
}

export interface CBKindFilter {
  id: string;
  kind: string;
  label: string;
  active: boolean;
}

export interface CBSortState {
  key: CBSortKey;
  dir: CBSortDir;
}
