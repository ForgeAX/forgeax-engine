import type { CBFileFamily, PreviewFileInfo } from '../types';

/** Keep in sync with `view-workspace-core/src/file-preview.ts`. */
export const MAX_BINARY_PREVIEW_BYTES = 10 * 1024 * 1024;

export function isBrowserMediaPreviewKind(kind: string): boolean {
  return kind === 'image' || kind === 'audio' || kind === 'video';
}

export function isFontPreviewInfo(info: Pick<PreviewFileInfo, 'kind' | 'mime'>): boolean {
  return info.kind === 'binary' && info.mime.startsWith('font/');
}

export function familySuggestsMediaPreview(family: CBFileFamily): boolean {
  return family === 'image' || family === 'audio' || family === 'font';
}

export function familySuggestsEnginePreview(family: CBFileFamily): boolean {
  return family === 'model';
}

export function svgMarkupSrc(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
}

export function mediaPreviewBlockedReason(
  info: PreviewFileInfo,
): 'too-large' | 'unavailable' | null {
  if (info.dataUrl || (info.kind === 'image' && info.content)) return null;
  if (info.size > MAX_BINARY_PREVIEW_BYTES) return 'too-large';
  return 'unavailable';
}
