import {
  createPreviewHost,
  PreviewCleanupError,
  type PreviewHostAdapter,
  type PreviewResourceCensus,
} from '@forgeax/engine/preview';
import { defineFeature } from '../../lab/feature';

const ZERO: PreviewResourceCensus = { worlds: 0, renderers: 0, canvases: 0, leases: 0 };

function adapter(leak: boolean, log: string[]): PreviewHostAdapter {
  return {
    open(request) {
      let live: PreviewResourceCensus = { worlds: 1, renderers: 1, canvases: 1, leases: 1 };
      log.push(`open:${request.subject.guid}`);
      return {
        subject: request.subject,
        snapshot: request.snapshot,
        loadAsset: async (guid) => {
          log.push(`load:${guid}`);
          return { guid, bytes: 64 };
        },
        frame: async (input) => {
          log.push(`frame:${input.frame}`);
        },
        capture: async () => {
          log.push('capture');
          return { digest: 'sha256:capture', bytes: 256 };
        },
        census: () => live,
        dispose: async () => {
          log.push('dispose');
          live = leak ? { ...ZERO, renderers: 1 } : ZERO;
        },
      };
    },
  };
}

const request = {
  subject: { kind: 'MeshAsset', guid: 'mesh-001' },
  snapshot: { revision: 3, digest: 'sha256:project' },
};

export default defineFeature({
  title: 'Preview lexical session',
  catalog: 'Preview lexical session',
  kind: 'headless',
  summary:
    'createPreviewHost(adapter).withSession opens one adapter session, hands the callback only POD bindings and bounded frame/capture actions, always disposes, and returns a cleanup census; a non-zero census throws PreviewCleanupError.',
  expect:
    'a clean session returns the callback value and a zero census after open/load/frame/capture/dispose; a throwing callback still disposes; a leaking adapter raises preview-cleanup-live-resources with renderers=1.',
  async run(checks) {
    const log: string[] = [];
    const host = createPreviewHost(adapter(false, log));
    const clean = await host.withSession(request, async (session) => {
      const binding = await session.loadAsset('mesh-001');
      await session.frame({ frame: 0, deltaSeconds: 0 });
      return { binding, capture: await session.capture() };
    });
    checks.equal('callback value', clean.value.capture.digest, 'sha256:capture');
    checks.equal(
      'binding is POD',
      JSON.stringify(clean.value.binding),
      JSON.stringify({ guid: 'mesh-001', bytes: 64 }),
    );
    checks.equal('zero census', JSON.stringify(clean.cleanup.census), JSON.stringify(ZERO));
    checks.equal(
      'lifecycle order',
      log.join(','),
      'open:mesh-001,load:mesh-001,frame:0,capture,dispose',
    );

    log.length = 0;
    await checks.run('throwing callback still disposes', async () => {
      try {
        await host.withSession(request, () => {
          throw new Error('lab boom');
        });
        return false;
      } catch {
        return log.includes('dispose') ? 'disposed after throw' : false;
      }
    });

    await checks.run('leak raises PreviewCleanupError', async () => {
      try {
        await createPreviewHost(adapter(true, [])).withSession(request, () => 1);
        return false;
      } catch (error) {
        return error instanceof PreviewCleanupError &&
          error.code === 'preview-cleanup-live-resources' &&
          error.census.renderers === 1
          ? `${error.code} renderers=1`
          : false;
      }
    });
  },
});
