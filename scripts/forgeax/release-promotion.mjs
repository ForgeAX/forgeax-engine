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
  const reports = [];
  for (const item of items) {
    reports.push(await upload(item, 'candidate'));
    // No dependent delivery unit is submitted before its predecessor is public.
    await wait([item]);
  }
  const consumer = await verifyConsumer();
  for (const item of items) await setTag(item, tag);
  const registry = await wait(items, tag);
  return { reports, consumer, registry, tag };
}
