import { releasePolicy } from './release-policy.mjs';

/** Mutable channel pointers move only after every immutable unit and consumer passes. */
export async function promoteRelease({ version, items, upload, wait, verifyConsumer, setTag }) {
  const { tag } = releasePolicy(version);
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
  for (const item of items) await setTag(item, tag);
  const registry = await wait(items, tag);
  return { reports, consumer, registry, tag };
}
