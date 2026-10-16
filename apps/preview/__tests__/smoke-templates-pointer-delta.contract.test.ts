import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  collectAssetDeclarationRoots,
  parseTemplateSmokeSlugs,
  selectTemplateAssetRoots,
} from '../src/template-asset-roots';

const smokeSource = readFileSync(
  resolve(import.meta.dirname, '../scripts/smoke-templates.mjs'),
  'utf8',
);
const viteConfigSource = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8');

describe('template smoke locked pointer delta', () => {
  it('drives the canvas input route with explicit relative movement', () => {
    expect(smokeSource).toContain('async function waitForLockedPointerLook');
    expect(smokeSource).toContain('const deadline = Date.now() + timeout');
    expect(smokeSource).toContain('const maxDispatches = 16');
    expect(smokeSource).toContain('if (dispatches < maxDispatches)');
    expect(smokeSource).toContain('await dispatchLockedPointerDelta(8, 2)');
    expect(smokeSource).toContain('latest.simulation?.fixedTick > origin.simulation.fixedTick');
    expect(smokeSource).toContain('yawDelta > 0.05');
    expect(smokeSource).toContain('yawDelta <= 0.4');
    expect(smokeSource).toContain('pitchDelta > 0.01');
    expect(smokeSource).toContain('pitchDelta <= 0.12');
    expect(smokeSource).toContain("new PointerEvent('pointermove'");
    expect(smokeSource).toContain('Object.defineProperties(event');
    expect(smokeSource).toContain('movementX: { configurable: true, value: deltaX }');
    expect(smokeSource).toContain('movementY: { configurable: true, value: deltaY }');
    expect(smokeSource).not.toContain('page.mouse.move(center.x + 96, center.y + 24)');
  });

  it('discovers only the canonical authored project roster', () => {
    expect(smokeSource).toContain("{ root: resolve(ROOT, 'templates/empty'), slug: 'empty'");
    expect(smokeSource).toContain("{ root: resolve(ROOT, 'templates/game-3d'), slug: 'game-3d'");
    expect(smokeSource).toContain("resolve(ROOT, 'apps/game-capability-lab')");
    expect(smokeSource).toContain("resolve(ROOT, 'apps/showcase/brotato-3d')");
    expect(smokeSource).toContain('missing project descriptor');
    expect(smokeSource).not.toContain('PROJECT_ROOTS');
    expect(smokeSource).not.toContain('readdirSync(parent');
  });

  it('includes nested template asset declarations in the Preview import closure', () => {
    const emptyAssets = resolve(import.meta.dirname, '../../../templates/empty/assets');
    const roots = collectAssetDeclarationRoots(emptyAssets);

    expect(roots).toContain(resolve(emptyAssets, 'world/world.scene.pack.json'));
  });

  it('limits Pack and producer roots to explicitly selected templates', () => {
    const selected = parseTemplateSmokeSlugs('empty,game-3d');
    const rootsByTemplate = [
      { slug: 'empty', roots: ['/templates/empty/assets/world/world.scene.pack.json'] },
      { slug: 'game-3d', roots: ['/templates/game-3d/assets/scene.pack.ts'] },
      {
        slug: 'game-capability-lab',
        roots: ['/apps/game-capability-lab/assets/resonance-forge.pack.ts'],
      },
      { slug: 'brotato-3d', roots: ['/apps/showcase/brotato-3d/assets/brotato-3d.pack.ts'] },
    ];

    expect(selectTemplateAssetRoots(rootsByTemplate, selected)).toEqual([
      '/templates/empty/assets/world/world.scene.pack.json',
      '/templates/game-3d/assets/scene.pack.ts',
    ]);
    expect(selectTemplateAssetRoots(rootsByTemplate, selected)).not.toEqual(
      expect.arrayContaining([
        '/apps/game-capability-lab/assets/resonance-forge.pack.ts',
        '/apps/showcase/brotato-3d/assets/brotato-3d.pack.ts',
      ]),
    );
    expect(selectTemplateAssetRoots(rootsByTemplate, parseTemplateSmokeSlugs(undefined))).toEqual(
      rootsByTemplate.flatMap(({ roots }) => roots),
    );
  });

  it('includes importer sidecars without promoting raw source files to roots', () => {
    const gameAssets = resolve(import.meta.dirname, '../../../templates/game-3d/assets');
    const roots = collectAssetDeclarationRoots(gameAssets);

    expect(roots).toContain(resolve(gameAssets, 'guide.ui.html.meta.json'));
    expect(roots).not.toContain(resolve(gameAssets, 'guide.ui.html'));
    expect(roots).not.toContain(resolve(gameAssets, 'guide.ui.css'));
  });

  it('excludes test fixture declarations at every nesting level', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-template-asset-roots-'));
    const nestedTests = join(root, 'nested', '__tests__');
    const rootTests = join(root, '__tests__', 'nested');
    const nestedMeta = join(root, 'nested', 'mesh.glb.meta.json');
    const rootPack = join(root, 'world.pack.json');
    try {
      mkdirSync(nestedTests, { recursive: true });
      mkdirSync(rootTests, { recursive: true });
      writeFileSync(join(nestedTests, 'fixture.pack.json'), '{}');
      writeFileSync(join(rootTests, 'fixture.meta.json'), '{}');
      writeFileSync(nestedMeta, '{}');
      writeFileSync(rootPack, '{}');

      expect(collectAssetDeclarationRoots(root)).toEqual([nestedMeta, rootPack]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates templates and the collision journey in fresh browser processes', () => {
    expect(smokeSource).toContain('async function restartSmokeBrowser(evidence)');
    expect(smokeSource).toContain('activeEvidence = undefined');
    expect(smokeSource).toContain('let context;');
    expect(smokeSource).toContain('targetBrowser.newContext');
    expect(smokeSource).toContain("await attemptClose('context'");
    expect(smokeSource).toContain('browser = await launchSmokeBrowser()');
    expect(smokeSource).toContain('page = await createSmokePage(browser,');
    const collisionJourney = smokeSource.slice(
      smokeSource.indexOf('// Restore the authored straight path'),
      smokeSource.indexOf('const collisionStart ='),
    );
    expect(collisionJourney.indexOf('await restartSmokeBrowser(evidence)')).toBeLessThan(
      collisionJourney.indexOf('await page.goto('),
    );
    const templateLoop = smokeSource.slice(
      smokeSource.indexOf('for (const template of templates)'),
      smokeSource.indexOf("writeReport('passed')"),
    );
    expect(templateLoop.indexOf('await restartSmokeBrowser(evidence)')).toBeLessThan(
      templateLoop.indexOf('await smokeTemplate(template, evidence)'),
    );
  });

  it('classifies pointer-lock support on the same game-3d page before navigation', () => {
    expect(smokeSource).toContain('async function probeNativePointerLock(probePage)');
    expect(smokeSource).toContain("const probeUrl = `${ORIGIN}/__forgeax-pointer-lock-probe__.html`");
    expect(smokeSource).toContain('await probePage.route(probeUrl, fulfillProbeDocument)');
    expect(smokeSource).toContain('await probePage.goto(probeUrl,');
    expect(smokeSource).toContain('await probePage.unroute(probeUrl, fulfillProbeDocument)');
    expect(smokeSource).toContain('nativePointerLockProbe = await probeNativePointerLock(nextPage)');
    expect(smokeSource).toContain(
      "pointerLockMode = nativePointerLockProbe.status === 'locked' ? 'native' : 'simulated'",
    );
    expect(smokeSource).toContain("probePointerLock: evidence?.slug === 'game-3d'");
    expect(smokeSource).toContain(
      'const interactionPointerLock = { mode: pointerLockMode, nativeProbe: nativePointerLockProbe }',
    );
    expect(smokeSource).toContain('pointerLock: interactionPointerLock');
    expect(smokeSource).not.toContain('nativePointerLockProbe = await probeNativePointerLock();');
  });

  it('keeps collision required except for the explicit SDK source-distribution route', () => {
    expect(smokeSource).toContain("FORGEAX_TEMPLATE_SMOKE_GAME3D_COLLISION_MODE ?? 'required'");
    expect(smokeSource).toContain("GAME3D_COLLISION_MODE !== 'required'");
    expect(smokeSource).toContain("GAME3D_COLLISION_MODE !== 'omit-sdk-source'");
    expect(smokeSource).toContain("GAME3D_COLLISION_MODE === 'required'");
    expect(smokeSource).toContain('await smokeGame3dCollision(evidence)');
    expect(smokeSource).toContain("{ status: 'omitted', reason: 'sdk-source-distribution' }");
  });

  it('waits on fixed-step progress with a bounded stall diagnostic', () => {
    expect(smokeSource).toContain('GAME3D_FIXED_TICK_PROGRESS_TIMEOUT_MS');
    expect(smokeSource).toContain('GAME3D_FIXED_TICK_STALL_TIMEOUT_MS = 20_000');
    expect(smokeSource).toContain('waitForGame3dFixedTicks');
    expect(smokeSource).toContain('lastProgressTick');
    expect(smokeSource).toContain("collisionStart.simulation.fixedTick,\n      48,\n      'game-3d collision approach'");
    expect(smokeSource).not.toContain("'game-3d collision approach',\n      15_000");
    expect(smokeSource).toContain('game-3d collision continued simulation');
  });

  it('rejects a healthy renderer that only presents the clear color', () => {
    expect(smokeSource).toContain("import { PNG } from 'pngjs'");
    expect(smokeSource).toContain('function game3dCanvasPixelStats(bytes)');
    expect(smokeSource).toContain("const bytes = await canvas.screenshot({ type: 'png' })");
    expect(smokeSource).toContain('stats.nonBlackPixels === 0 || stats.lumaRange <= GAME3D_MIN_LUMA_RANGE');
    expect(smokeSource).toContain('game-3d canvas was blank');
    expect(smokeSource).toContain("game-3d-render.png");
    expect(smokeSource).toContain('const render = await readGame3dCanvasRender()');
    expect(smokeSource).toContain('render,');
  });

  it('audits only one exact pre-completion SDK host GPU loss with fresh-process viability', () => {
    expect(smokeSource).toContain('SDK_SOURCE_HOST_GPU_INSTANCE_LOSS_CONSOLE');
    expect(smokeSource).toContain("matchingEvents[0]?.phase !== 'interaction'");
    expect(smokeSource).toContain('matchingEvents[0].sequence >= evidence.journeyCompleteSequence');
    expect(smokeSource).toContain("rendererHealth?.reason !== 'device-lost'");
    expect(smokeSource).toContain('async function probeFreshGame3dRendererViability');
    expect(smokeSource).toContain("health?.reason === 'alive' && (health.frame?.frameId ?? -1) > 0");
    expect(smokeSource).toContain('evidence.game3d.freshProcessRendererHealth');
    expect(smokeSource).toContain("reason: 'sdk-source-host-gpu-instance-loss'");
    expect(smokeSource).toContain('activeEvidence.consoleErrorEvents.push');
    expect(smokeSource).toContain("evidence.phase = 'journey-complete'");
    expect(smokeSource).toContain(
      "evidence.game3d?.collision?.status === 'omitted' ? 'passed-with-omissions' : 'passed'",
    );
  });
});

describe('template smoke server readiness', () => {
  it('uses a bounded configurable startup budget instead of the old fixed timeout', () => {
    expect(smokeSource).toContain('DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 90_000');
    expect(smokeSource).toContain('MAX_SERVER_STARTUP_TIMEOUT_MS = 180_000');
    expect(smokeSource).toContain('FORGEAX_TEMPLATE_SMOKE_SERVER_STARTUP_TIMEOUT_MS');
    expect(smokeSource).toContain('Math.min(configuredServerStartupTimeoutMs, MAX_SERVER_STARTUP_TIMEOUT_MS)');
    expect(smokeSource).toContain('await waitForServerReady()');
    expect(smokeSource).not.toContain('const serverDeadline = Date.now() + 30_000');
  });

  it('keeps process and response diagnostics on every startup failure path', () => {
    expect(smokeSource).toContain('server.on(\'error\', (error) => { serverSpawnError = error; });');
    expect(smokeSource).toContain('server.on(\'exit\', (code, signal) => { serverExit = { code, signal }; });');
    expect(smokeSource).toContain('function serverDiagnostics(lastStatus, elapsedMs)');
    expect(smokeSource).toContain('lastStatus: lastStatus ?? null');
    expect(smokeSource).toContain("appendServerOutput('stdout', chunk)");
    expect(smokeSource).toContain("appendServerOutput('stderr', chunk)");
    expect(smokeSource).toContain("output: serverOutput.trim() || 'none'");
    expect(smokeSource).toContain('Preview server exited before becoming ready');
    expect(smokeSource).toContain('Preview server did not become ready within');
  });
});

describe('game-3d collision startup closure', () => {
  it('does not scan unrelated Preview fixtures for the isolated game-3d lane', () => {
    expect(viteConfigSource).toContain(
      "const game3dOnlySmoke =\n  selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'game-3d';",
    );
    expect(viteConfigSource).toContain(
      "const materialPackages = selectedTemplateSlugs.length > 0 && !selectedTemplateSlugs.includes('game-capability-lab')\n  ? []\n  : [",
    );
    expect(viteConfigSource).toContain("...(game3dOnlySmoke || (selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'empty')\n        ? []");
    expect(viteConfigSource).toContain('surfaceEvidencePackRoot');
    expect(viteConfigSource).toContain('externalAssetRoots.filter((root) => existsSync(root))');
  });

  it('keeps all template roots and external resources while excluding independent evidence fixtures', () => {
    expect(viteConfigSource).toContain("...(process.env.FORGEAX_TEMPLATE_SMOKE === '1'\n              ? []\n              : [surfaceEvidencePackRoot, previewUiAuthoringMetaPath])");
    expect(viteConfigSource).toContain('...templatePackRoots,');
    expect(viteConfigSource).toContain('...externalAssetRoots.filter((root) => existsSync(root))');
    expect(smokeSource).toContain('for (const template of templates)');
  });
});
