import { createHash } from 'node:crypto';
import { DdcEntryStore, ddcOutputDigest, withDdcLock } from '@forgeax/engine-ddc';
import { THUMBNAIL_PREVIEW } from '@forgeax/engine-preview';

export function thumbnailKey(input: string, producer: string): string {
  return createHash('sha256')
    .update(JSON.stringify([THUMBNAIL_PREVIEW, producer, input]))
    .digest('hex');
}

export function thumbnailPng(dataUrl: string): Uint8Array {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Preview returned no PNG');
  const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
  if (
    bytes.length < 24 ||
    bytes.length > 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== THUMBNAIL_PREVIEW.size ||
    bytes.readUInt32BE(20) !== THUMBNAIL_PREVIEW.size
  )
    throw new Error('Preview returned an invalid thumbnail PNG');
  return bytes;
}

export function createThumbnailCache(root: string) {
  const store = new DdcEntryStore(root);
  return {
    async read(key: string): Promise<string | undefined> {
      const entry = await store.read(key);
      const image = entry?.artifacts['preview.png'];
      if (!image || image.mediaType !== 'image/png') return undefined;
      const dataUrl = `data:image/png;base64,${Buffer.from(image.bytes).toString('base64')}`;
      try {
        thumbnailPng(dataUrl);
        return dataUrl;
      } catch {
        return undefined;
      }
    },
    async write(key: string, guid: string, producer: string, dataUrl: string): Promise<void> {
      const body = {
        guid,
        payload: THUMBNAIL_PREVIEW,
        refs: [],
        artifacts: { 'preview.png': { mediaType: 'image/png', bytes: thumbnailPng(dataUrl) } },
      };
      await withDdcLock(root, key, async () => {
        const existing = await store.readChecked(key);
        if (!existing.ok) await store.remove(key);
        if (existing.ok && existing.value) return;
        const staged = await store.stage({
          ...body,
          key,
          receipt: {
            guid,
            key,
            producer,
            inputFingerprint: key,
            outputDigest: ddcOutputDigest(body),
          },
        });
        const published = await store.publish(staged);
        if (published.result === 'conflict') throw new Error('Preview cache content conflict');
      });
    },
  };
}
