import { releasePolicy } from './release-policy.mjs';

/** Immutable units upload together; consumers prove the public bytes before any channel moves. */
export async function publishRelease({ items, upload, wait, verifyConsumer }) {
  if (
    items.some(
      (item) => item.name.startsWith('@forgeax/engine-') && item.name !== '@forgeax/engine-sdk',
    )
  )
    throw new Error('release-focused-package-forbidden');
  const uploads = await Promise.allSettled(items.map(async (item) => upload(item, 'candidate')));
  const failed = uploads.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  const reports = uploads.map((result) => result.value);
  await wait(items);
  const consumer = await verifyConsumer();
  return { reports, consumer };
}

/** Mutable channel pointers move only after every immutable unit and consumer passed. */
export async function promoteRelease({ version, items, wait, setTag }) {
  const { tag } = releasePolicy(version);
  for (const item of items) await setTag(item, tag);
  const registry = await wait(items, tag);
  return { registry, tag };
}
