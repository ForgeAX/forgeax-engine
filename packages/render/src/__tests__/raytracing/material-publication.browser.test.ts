import { it } from 'vitest';
import { commands } from 'vitest/browser';
import { verifyPublishedRayMaterial } from './material-publication.gpu-fixture';

it('traces with accepted material snapshots and replays retired parameter, Surface and transport outputs', async () => {
  await verifyPublishedRayMaterial(await commands.prepareRayPublicationFixture('emission'));
}, 120_000);
