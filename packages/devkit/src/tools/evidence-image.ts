import { writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ArtifactRef, PreviewArtifactManifestEntry } from '@forgeax/engine-tool-runtime';
import { sha256 } from '@forgeax/engine-types';

export function projectArtifactUri(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

export const PNG_DATA_URI = 'data:image/png;base64,';

export function decodeArtifactDataUri(uri: string): Buffer {
  const separator = uri.indexOf(',');
  if (separator < 0) throw new TypeError('preview artifact must be a data URI before publication');
  return Buffer.from(uri.slice(separator + 1), 'base64');
}

export function toolRunDirectory(projectRoot: string, runId: string): string {
  return join(projectRoot, '.forgeax', 'tool-runs', runId.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

export function artifactDigest(bytes: Uint8Array): string {
  return `sha256:${sha256(bytes)}`;
}

export async function publishPng(
  root: string,
  path: string,
  bytes: Uint8Array,
): Promise<ArtifactRef> {
  await writeFile(path, bytes);
  return {
    kind: 'png',
    digest: artifactDigest(bytes),
    uri: projectArtifactUri(root, path),
    mediaType: 'image/png',
    sizeBytes: bytes.byteLength,
  };
}

export function previewArtifactRef(artifact: PreviewArtifactManifestEntry): ArtifactRef {
  const kind =
    artifact.kind === 'report' || artifact.kind === 'contact-sheet'
      ? ('tool-result' as const)
      : artifact.kind;
  return {
    kind,
    digest: artifact.digest,
    uri: artifact.uri,
    mediaType: artifact.mediaType,
    sizeBytes: artifact.byteLength,
  };
}

// The model sheet and heat map use the same 5x7 alphabet with distinct presentation glyphs.
const SHARED_GLYPHS: Readonly<Record<string, string>> = {
  '0': '01110100011001110101110011000101110',
  '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010',
  '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110',
  '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100',
  '.': '00000000000000000000000000110001100',
  '-': '00000000000000011111000000000000000',
  '+': '00000001000010011111001000010000000',
  '%': '11000110010001000100010001001100011',
  '(': '00010001000100001000010000010000010',
  ')': '01000001000001000010000100010001000',
  ':': '00000011000110000000011000110000000',
  '=': '00000000001111100000111110000000000',
  A: '01110100011000111111100011000110001',
  B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110',
  D: '11100100101000110001100011001011100',
  E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111',
  H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110',
  K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000',
  R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001',
};
const MODEL_GLYPHS: Readonly<Record<string, string>> = {
  ...SHARED_GLYPHS,
  J: '00111000100001000010000101001001100',
  Q: '01110100011000110001101011001001101',
  Y: '10001100011000101010001000010000100',
  Z: '11111000010001000100010001000011111',
  ',': '00000000000000000000011000010001000',
  '/': '00000000010001000100010001000000000',
  _: '00000000000000000000000000000011111',
  "'": '01100001000100000000000000000000000',
  '#': '01010010101111101010111110101001010',
  '[': '01110010000100001000010000100001110',
  ']': '01110000100001000010000100001001110',
  ' ': '00000000000000000000000000000000000',
  '?': '01110100010000100010001000000000100',
};
const LEGEND_GLYPHS: Readonly<Record<string, string>> = {
  ...SHARED_GLYPHS,
  '<': '00010001000100010000010000010000010',
  '>': '10000010000010000010001000100010000',
  '|': '00100001000010000100001000010000100',
  Y: '10001100010101000100001000010000100',
};

export const BITMAP_GLYPH_ADVANCE = 6;

export function bitmapText(
  text: string,
  x: number,
  y: number,
  scale: number,
  font: 'model' | 'legend',
  draw: (x: number, y: number) => void,
): void {
  const glyphs = font === 'model' ? MODEL_GLYPHS : LEGEND_GLYPHS;
  const fallback = font === 'model' ? MODEL_GLYPHS['?'] : undefined;
  for (const [index, character] of [...text.toUpperCase()].entries()) {
    const glyph = glyphs[character] ?? fallback;
    if (glyph === undefined) continue;
    for (let row = 0; row < 7; row++)
      for (let column = 0; column < 5; column++)
        if (glyph[row * 5 + column] === '1') {
          draw(x + (index * BITMAP_GLYPH_ADVANCE + column) * scale, y + row * scale);
        }
  }
}
