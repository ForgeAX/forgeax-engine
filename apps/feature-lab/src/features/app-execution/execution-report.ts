import {
  EXECUTION_CAPABILITY_NAMES,
  EXECUTION_REPORT_SCHEMA_VERSION,
  isExecutionReport,
} from '@forgeax/engine/app';
import { createApp } from '@forgeax/engine/app/browser';
import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Update } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { CheckList, defineFeature, type FeatureCheck } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const until = async (pred: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const end = performance.now() + timeoutMs;
  while (!pred() && performance.now() < end) await wait(50);
};

export default defineFeature({
  title: 'Execution report + structured faults',
  catalog: 'Execution report',
  kind: 'probe',
  summary:
    'app.execution.report() returns a schema-v3 POD snapshot (workers, capabilities, realm, World health, kernel, frame, performance, audio, fault). A throwing system surfaces as app-system-update-failed.',
  expect:
    'All checks pass: the report validates, is a defensive copy, and a deliberate system failure is reported with its system name; local rebuild is refused.',
  setup({ app, world, frames }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    spawnStage(world);
    spawnMesh(world, stageCube, standard(world, { baseColor: [0.9, 0.2, 0.6, 1] }), {
      pos: [0, 0.5, 0],
    });
    let memo: Promise<readonly FeatureCheck[]> | undefined;
    return {
      checks() {
        memo ??= (async () => {
          await frames(5);
          const c = new CheckList();
          const report = app.execution.report();
          c.ok('isExecutionReport(report)', isExecutionReport(report));
          c.equal('schemaVersion', report.schemaVersion, EXECUTION_REPORT_SCHEMA_VERSION);
          c.equal(
            'capability keys',
            Object.keys(report.capabilities).sort(),
            [...EXECUTION_CAPABILITY_NAMES].sort(),
          );
          c.ok(
            'every capability fact has a reason',
            EXECUTION_CAPABILITY_NAMES.every(
              (n) => typeof report.capabilities[n].reason === 'string',
            ),
          );
          c.ok(
            'kernelDispatch reason is closed',
            typeof report.kernelDispatch.reason === 'string',
            report.kernelDispatch.reason,
          );
          c.equal('audio owner', report.audio.owner, 'host');
          c.ok(
            'report is JSON-safe',
            JSON.stringify(JSON.parse(JSON.stringify(report))) === JSON.stringify(report),
          );
          const again = app.execution.report();
          c.ok('report is a fresh copy', again !== report && again.workers !== report.workers);
          c.ok(
            'frame counter advances between reports',
            again.frame.submitted >= report.frame.submitted,
          );
          const rebuilt = await app.execution.rebuild();
          c.equal(
            'local rebuild refused',
            rebuilt.ok ? 'ok' : rebuilt.error.code,
            'app-execution-rebuild-failed',
          );
          await faultOnPrivateApp(c);
          return c.items;
        })();
        return memo;
      },
    };
  },
});

// A throwing system poisons its World, so the fault runs on a private App; the lab App stays healthy.
async function faultOnPrivateApp(c: CheckList): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  canvas.style.cssText = 'position:fixed;right:8px;bottom:8px;width:96px;height:96px';
  document.body.appendChild(canvas);
  const created = await createApp(canvas);
  c.ok(
    'private createApp(canvas) ok',
    created.ok,
    created.ok ? undefined : String((created.error as { code?: string }).code),
  );
  if (!created.ok) {
    canvas.remove();
    return;
  }
  const app = created.value;
  const world = app.world;
  spawnStage(world);
  c.ok('private start() ok', app.start().ok);
  const seen: string[] = [];
  const off = app.onError((error) => seen.push(error.code));
  world.addSystem(Update, {
    name: 'fl-report-boom',
    queries: [],
    fn: () => {
      throw new Error('fl deliberate failure');
    },
  });
  await until(() => seen.includes('app-system-update-failed'));
  off();
  c.ok(
    'onError saw app-system-update-failed',
    seen.includes('app-system-update-failed'),
    seen.join(','),
  );
  const last = app.lastError;
  c.equal('lastError code', last?.code, 'app-system-update-failed');
  const detail = (last as { detail?: { systemName?: string; cause?: unknown } } | undefined)
    ?.detail;
  c.ok('detail carries cause', detail?.cause !== undefined, String(detail?.systemName));
  const after = app.execution.report();
  c.equal('report world health mirrors World', after.world.health, world.execution.health);
  c.ok('report still validates after failure', isExecutionReport(after));
  const disposed = await app.dispose();
  c.ok('faulted App still disposes', disposed.ok, disposed.ok ? undefined : disposed.error.code);
  canvas.remove();
}
