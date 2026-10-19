import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { captureGpuErrors, captureWorldErrors, requireFrameMaterials, disposeRenderResources, runPairedStages, runRenderPhase } from '../../evidence/phase-executor.mjs';

const read = (name: string) => readFileSync(new URL(`../../scripts/${name}`, import.meta.url), 'utf8');
const readSource = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('physical material smoke contract', () => {
  it('requires real browser readback after the 60-frame threshold', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain('JSON.stringify');
    expect(source).toContain('frameCount ?? 0) >= 60');
    expect(source).toContain("readback?.status !== 'ok'");
    expect(source).toContain("readback?.status === 'ok' && readback.nonZeroBytes > 0");
    expect(source).toContain('const evidenceTimeout = 60_000');
    expect(source).not.toContain('canvas liveness');
  });

  it('requires the browser carrier to load the full physical root by GUID', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain('materialLoad?.status === \'ok\'');
    expect(source).toContain('physical material GUID load timeout');
    expect(readSource('main.ts')).toContain('assets.loadByGuid<MaterialAsset>');
  });

  it('starts Vite from the carrier root', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain('cwd: appRoot');
    expect(source).toContain('FORGEAX_BROWSER_PORT');
  });

  it('keeps the browser carrier legend aligned with the 4x2 witness matrix', () => {
    const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    for (const label of ['R FACTOR', 'G ROUGHNESS', 'RG COAT NORMAL', 'RG ISOLATION', 'RIGID BOX', 'SKINNED TRIANGLE']) {
      expect(source).toContain(label);
    }
    expect(source).toContain('same red base');
    expect(source).toContain('linear HDR');
  });

  it('keeps both physical material target identities in the manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../evidence/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.targets.map((target: { id: string }) => target.id)).toEqual([
      'physical-material-layer-grid',
      'physical-material-rigid-skinned',
    ]);
    expect(manifest.requiredEvidence).toContain('exact-head-provenance');
  });

  it('defines the complete direct/IBL, rigid/skinned, channel case matrix in one SSOT', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../evidence/case-manifest.json', import.meta.url), 'utf8'));
    expect(manifest.caseCount).toBe(16);
    expect(manifest.roiLayout).toBe('phase-local-4x2');
    expect(manifest.caseInput).toBe('case-input.json');
    expect(manifest.cases).toHaveLength(16);
    expect(new Set(manifest.cases.map((item: { caseId: string }) => item.caseId)).size).toBe(16);
    expect(new Set(manifest.cases.map((item: { lighting: string }) => item.lighting)).size).toBe(2);
    expect(new Set(manifest.cases.map((item: { geometry: string }) => item.geometry)).size).toBe(2);
    expect(new Set(manifest.cases.map((item: { semantic: string }) => item.semantic)).size).toBe(4);
    expect(manifest.pairedSentinels).toEqual([
      'factor-zero-base-parity',
      'default-custom-surface-physical-parity',
      'additive-coat-falsifier',
    ]);
    for (const item of manifest.cases) {
      const index = manifest.cases.filter((candidate: { lighting: string }) => candidate.lighting === item.lighting).indexOf(item);
      expect(item.roi).toBeUndefined();
      expect(index).toBeGreaterThanOrEqual(0);
    }
  });

  it('binds every case to the independent replayable HDR reference artifact', async () => {
    const manifest = JSON.parse(readFileSync(new URL('../../evidence/case-manifest.json', import.meta.url), 'utf8'));
    const artifact = JSON.parse(readFileSync(new URL('../../evidence/reference-linear-hdr.json', import.meta.url), 'utf8'));
    expect(manifest.referenceArtifact.artifactId).toBe(artifact.artifactId);
    expect(manifest.referenceArtifact.revision).toBe(artifact.revision);
    expect(artifact.cases).toHaveLength(16);
    expect(artifact.cases.every((item: { expectedLinearHdrMean?: number[]; referenceHash?: string }) =>
      item.expectedLinearHdrMean?.length === 3 && typeof item.referenceHash === 'string' && /^[0-9a-f]{64}$/.test(item.referenceHash),
    )).toBe(true);
  });

  it('binds reference and Dawn smoke to one serializable scene input', () => {
    const input = JSON.parse(readFileSync(new URL('../../evidence/case-input.json', import.meta.url), 'utf8'));
    const referenceSource = readFileSync(new URL('../../evidence/reference-generator.mjs', import.meta.url), 'utf8');
    const smokeSource = read('smoke-dawn.mjs');
    expect(input.render).toMatchObject({ width: 200, height: 150, tonemap: 'reinhard-extended', exposure: 1, whitePoint: 8 });
    expect(input.directLight).toMatchObject({ direction: [-0.4, -0.8, -0.3], intensity: 2 });
    expect(input.ibl.sourceGuid).toBe('019e4a26-3c29-7420-af5d-20f2724a16b0');
    expect(input.geometry.skinned.pose).toHaveLength(2);
    expect(input.projection).toMatchObject({ roiLayout: 'phase-local-4x2', roiWidth: 50, roiHeight: 75 });
    expect(referenceSource).toContain("'./case-input.json'");
    expect(smokeSource).toContain("'..', 'evidence', 'case-input.json'");
    expect(smokeSource).toContain('caseInput.geometry.casePositions');
    expect(smokeSource).toContain('caseInput.geometry.skinned.pose');
    expect(smokeSource).toContain('assets.loadByGuid(fullMaterialGuid.value)');
    expect(smokeSource).toContain('materialLoad: fullPhysicalMaterialLoad');
  });

  it('records anchor projection and object-mask diagnostics with each HDR ROI', () => {
    const source = read('smoke-dawn.mjs');
    expect(source).toContain('materialDiagnostic');
    expect(source).toContain('cookedPublication');
    expect(source).toContain('bindingCensus');
    expect(source).toContain('objectMask');
    expect(source).toContain('residual:');
  });

  it('closes Dawn renderer and targets before process exit', () => {
    const source = read('smoke-dawn.mjs');
    const phaseExecutor = readFileSync(new URL('../../evidence/phase-executor.mjs', import.meta.url), 'utf8');
    expect(source).toContain('disposeRenderResources({ renderer, mutantRenderer, renderTarget, mutantRenderTarget, device: sharedDevice })');
    expect(phaseExecutor).toContain('await renderer.dispose();');
    expect(phaseExecutor).toContain('await mutantRenderer.dispose();');
    expect(phaseExecutor).toContain('renderTarget?.destroy();');
    expect(phaseExecutor).toContain('mutantRenderTarget?.destroy();');
    expect(phaseExecutor).toContain('device?.destroy?.();');
  });

  it('returns the graph capture record to its caller', () => {
    const source = read('smoke-dawn.mjs');
    const functionStart = source.indexOf('async function readGraphTargetCapture');
    const functionEnd = source.indexOf('\n}\n\nconst anchorEntity', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = source.slice(functionStart, functionEnd);
    expect(functionSource).toContain('const record = {');
    expect(functionSource).toContain('return record;');
  });

  it('owns frame count and returns the last successful receipt', async () => {
    let updates = 0;
    let draws = 0;
    const receipt = await runRenderPhase({
      phase: 'direct',
      frameCount: 3,
      world: { update: () => ({ unwrap: () => { updates += 1; } }) },
      renderer: { draw: () => ({ ok: true, value: { frameId: ++draws, presentation: 'ready', completed: Promise.resolve({ ok: true }) } }) },
      frameRequest: {},
      yieldFrame: async () => {},
    });
    expect(updates).toBe(3);
    expect(draws).toBe(3);
    expect(receipt).toMatchObject({ frameId: 3 });
  });

  it('waits for GPU completion before observing or advancing the phase', async () => {
    let finish!: (result: { ok: true }) => void;
    let start!: () => void;
    const completed = new Promise<{ ok: true }>((resolve) => { finish = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    const events: string[] = [];
    const running = runRenderPhase({
      phase: 'ibl', frameCount: 1,
      world: { update: () => ({ unwrap: () => {} }) },
      renderer: { draw: () => {
        start();
        return { ok: true, value: { frameId: 1, presentation: 'ready', completed } };
      } },
      frameRequest: {},
      afterDraw: () => events.push('observe'),
      yieldFrame: async () => { events.push('advance'); },
    });
    await started;
    expect(events).toEqual([]);
    finish({ ok: true });
    await running;
    expect(events).toEqual(['observe', 'advance']);
  });

  it('rejects a submitted frame whose GPU completion failed', async () => {
    const error = { code: 'device-lost' };
    await expect(runRenderPhase({
      phase: 'ibl', frameCount: 1,
      world: { update: () => ({ unwrap: () => {} }) },
      renderer: { draw: () => ({ ok: true, value: {
        frameId: 1, presentation: 'ready', completed: Promise.resolve({ ok: false, error }),
      } }) },
      frameRequest: {}, yieldFrame: async () => {},
    })).rejects.toEqual(error);
  });

  it('rejects a draw failure after a completed frame instead of returning partial evidence', async () => {
    const error = { code: 'draw-failed' };
    const failures: unknown[] = [];
    let draws = 0;
    let advanced = 0;
    await expect(runRenderPhase({
      phase: 'direct', frameCount: 3,
      world: { update: () => ({ unwrap: () => {} }) },
      renderer: { draw: () => ++draws === 1
        ? { ok: true, value: { frameId: 1, presentation: 'ready', completed: Promise.resolve({ ok: true }) } }
        : { ok: false, error } },
      frameRequest: {},
      yieldFrame: async () => { advanced += 1; },
      onDrawError: (phase: string, frame: number, cause: unknown) => failures.push({ phase, frame, cause }),
    })).rejects.toBe(error);
    expect(draws).toBe(2);
    expect(advanced).toBe(1);
    expect(failures).toEqual([{ phase: 'direct', frame: 1, cause: error }]);
  });

  it('fails when a phase has no successful receipt', async () => {
    const errors: number[] = [];
    const error = { code: 'draw-failed' };
    await expect(runRenderPhase({
      phase: 'ibl',
      frameCount: 2,
      world: { update: () => ({ unwrap: () => {} }) },
      renderer: { draw: () => ({ ok: false, error }) },
      frameRequest: {},
      yieldFrame: async () => {},
      onDrawError: (_phase: string, frame: number) => errors.push(frame),
    })).rejects.toBe(error);
    expect(errors).toEqual([0]);
  });

  it('executes paired stages in manifest order', async () => {
    const order: string[] = [];
    const result = await runPairedStages({
      stages: ['base', 'factor-zero', 'default'],
      captureStage: async (stage: string) => {
        order.push(stage);
        return { stage };
      },
    });
    expect(order).toEqual(['base', 'factor-zero', 'default']);
    expect(result).toEqual({ base: { stage: 'base' }, 'factor-zero': { stage: 'factor-zero' }, default: { stage: 'default' } });
  });

  it('aggregates cleanup failures without skipping remaining resources', async () => {
    const destroyed: string[] = [];
    const errors = await disposeRenderResources({
      renderer: { dispose: async () => ({ ok: false, error: { code: 'renderer-failed' } }) },
      mutantRenderer: { dispose: async () => ({ ok: false, error: { code: 'mutant-failed' } }) },
      renderTarget: { destroy: () => destroyed.push('target') },
      mutantRenderTarget: { destroy: () => destroyed.push('mutant-target') },
      device: { destroy: () => destroyed.push('device') },
    });
    expect(errors).toEqual(['renderer-dispose-failed:renderer-failed', 'mutant-renderer-dispose-failed:mutant-failed']);
    expect(destroyed).toEqual(['target', 'mutant-target', 'device']);
  });

  it('keeps Browser manifest evidence on a text parse roundtrip', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain('const serialized = await response.text();');
    expect(source).toContain('JSON.stringify(JSON.parse(serialized))');
  });

  it('does not wait for network idle before observing the Engine page', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain("page.goto(url, { waitUntil: 'domcontentloaded' })");
  });

  it('fails closed on Browser semantic, paired, and runtime errors', () => {
    const source = read('smoke-browser.mjs');
    expect(source).toContain("evidence.semanticEvaluation?.verdict !== 'pass'");
    expect(source).toContain("evidence.pairedSentinelEvaluation?.verdict !== 'pass'");
    expect(source).toContain('evidence.errors.length !== 0');
    expect(source).toContain('browser page/console/request errors');
    expect(source).toContain('requestfailed');
  });

  it('uses the browser-safe shared executor and exact-head projection', () => {
    const source = readSource('main.ts');
    const executor = readFileSync(new URL('../../evidence/browser-executor.mjs', import.meta.url), 'utf8');
    expect(source).toContain("'../evidence/browser-executor.mjs'");
    expect(source).toContain('createBrowserCasePlans');
    expect(source).toContain('evaluateBrowserRecords');
    expect(source).toContain('createBrowserPhaseController');
    expect(source).not.toContain('paired-executor-not-implemented');
    expect(executor).toContain('export function evaluateBrowserPairedSentinels');
    expect(executor).toContain('evaluatePairedSentinelsCore');
    const phaseController = readFileSync(new URL('../../evidence/browser-phase-controller.mjs', import.meta.url), 'utf8');
    expect(phaseController).toContain('evaluateBrowserPairedSentinels');
    expect(phaseController).toContain("pairStage = 'done'");
    expect(executor).toContain('referenceArtifactHash(plan)');
    expect(source).toContain('caseManifest.cases.filter');
    expect(source).toContain('__FORGEAX_PHYSICAL_MATERIAL_EXACT_HEAD__');
    expect(source).toContain('configureRuntimeAssetCatalog(assets, runtimeBinding)');
    expect(source).toContain('createRuntimeAssetImportTransport(runtimeBinding)');
    expect(source).toContain('controller.onFrame');
    expect(phaseController).toContain('evidence.caseRecords = records');
  });

  it('packs the skinned mesh through the canonical vertex owner', () => {
    const source = readSource('main.ts');
    expect(source).toContain('packInterleavedVertexAttributes');
    expect(source).toContain('vertices: skinnedPacked.value.vertices');
    expect(source).not.toContain('vertices: new Float32Array(3 * 18)');
  });

  it('keeps the browser additive mutant valid across clearcoat-disabled variants', () => {
    const source = readFileSync(new URL('../../evidence/additive-coat-mutant.mjs', import.meta.url), 'utf8');
    expect(source).toContain("source.includes('evaluateClearcoatLayer')");
    expect(source).toContain('Additive mutant attenuation needle missing');
  });

  it('pairs Dawn additive baseline and mutant on one authored material identity', () => {
    const source = read('smoke-dawn.mjs');
    expect(source).toContain('const additiveBaselineMaterial = makePairMaterial(1, false);');
    expect(source).toContain('const additiveMutationMaterial = makePairMaterial(1, false);');
    expect(source).toContain('additivePairIdentity(additiveBaselineMaterial) !== additivePairIdentity(additiveMutationMaterial)');
    expect(source).toContain('additiveMutationMaterial,\n  pairSentinelRoi');
    expect(source).toContain('const warmupFrames = pairRenderer === renderer ? 1 : 2;');
  });

  it('rejects preparation that never produces a ready scene', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15_001);
    try {
      await expect(runRenderPhase({
        phase: 'paired', frameCount: 1,
        world: { update: () => ({ unwrap() {} }) },
        renderer: { draw: () => ({ ok: true, value: {
          frameId: 1, presentation: 'pending', completed: Promise.resolve({ ok: true }),
        } }) },
        frameRequest: {}, yieldFrame: async () => {},
      })).rejects.toThrow('Renderer scene presentation did not become ready');
    } finally {
      clock.mockRestore();
    }
  });

  it('retries preparation without advancing simulation and re-arms submission observations', async () => {
    let draws = 0;
    let updates = 0;
    const prepared: number[] = [];
    const observed: number[] = [];
    const receipt = await runRenderPhase({
      phase: 'direct', frameCount: 3,
      world: { update: () => ({ unwrap() { updates += 1; } }) },
      renderer: { draw: () => ({ ok: true, value: {
        frameId: ++draws, presentation: draws <= 2 ? 'pending' : 'ready',
        completed: Promise.resolve({ ok: true }),
      } }) },
      frameRequest: {}, yieldFrame: async () => {},
      beforeDraw: (frame: number) => prepared.push(frame),
      afterDraw: (_frame: number, current: { frameId: number }) => observed.push(current.frameId),
    });
    expect(updates).toBe(3);
    expect(draws).toBe(5);
    expect(prepared).toEqual([0, 0, 0, 1, 2]);
    expect(observed).toEqual([3, 4, 5]);
    expect(receipt.frameId).toBe(5);
  });

  it('refreshes an exact capture identity when the last phase picture is pending', async () => {
    let nativeFrame = 0;
    let expectedFrame = 0;
    let updates = 0;
    const observed: number[] = [];
    await runRenderPhase({
      phase: 'ibl', frameCount: 3,
      world: { update: () => ({ unwrap() { updates += 1; } }) },
      renderer: { draw: () => {
        nativeFrame += 1;
        if (nativeFrame !== 3 && expectedFrame !== nativeFrame)
          return { ok: false, error: new Error('identity-mismatch') };
        return { ok: true, value: {
          frameId: nativeFrame, presentation: nativeFrame === 3 ? 'pending' : 'ready',
          completed: Promise.resolve({ ok: true }),
        } };
      } },
      frameRequest: {}, yieldFrame: async () => {},
      beforeDraw: () => { expectedFrame = nativeFrame + 1; },
      afterDraw: (_frame: number, current: { frameId: number }) => observed.push(current.frameId),
    });
    expect(updates).toBe(3);
    expect(observed).toEqual([1, 2, 4]);
  });

  it('retains native GPU validation errors and forwards the installed handler', () => {
    const forwarded: unknown[] = [];
    const original = (event: unknown) => forwarded.push(event);
    const device = { onuncapturederror: original };
    const errors: string[] = [];
    const restore = captureGpuErrors(device, errors);
    const event = { error: { message: 'Binding entry textureView not set.' } };
    device.onuncapturederror(event);
    expect(errors).toEqual(['gpu:Binding entry textureView not set.']);
    expect(forwarded).toEqual([event]);
    restore();
    expect(device.onuncapturederror).toBe(original);
  });

  it('retains structured World extraction errors while forwarding the original diagnostic', () => {
    const forwarded: unknown[][] = [];
    const hostConsole = { error: (...args: unknown[]) => forwarded.push(args) };
    const original = hostConsole.error;
    const errors: string[] = [];
    const restore = captureWorldErrors(errors, hostConsole);
    const error = { code: 'material-specialization-not-cooked' };
    hostConsole.error('[RenderSystem.extractFrames(world[0])]', error);
    expect(errors).toEqual(['world:material-specialization-not-cooked']);
    expect(forwarded).toEqual([['[RenderSystem.extractFrames(world[0])]', error]]);
    restore();
    expect(hostConsole.error).toBe(original);
  });

  it('rejects a ready frame with a skipped World or an earlier material binding', () => {
    const receipt = { frameId: 62, presentation: 'ready' };
    const expected = [{ entityKey: 7, handle: 1043 }];
    expect(() => requireFrameMaterials(receipt, { meshMaterialBindings: [] }, 'world', expected)).toThrow();
    const row = {
      worldIdentity: 'world', entityKey: 7, bindings: [{ handle: 1042 }],
      residency: [{ readiness: 'ready' }], diagnostics: [],
    };
    expect(() => requireFrameMaterials(receipt, { meshMaterialBindings: [row] }, 'world', expected)).toThrow();
    row.bindings[0]!.handle = 1043;
    expect(requireFrameMaterials(receipt, { meshMaterialBindings: [row] }, 'world', expected)).toMatchObject({
      frameId: 62, materials: expected,
    });
    row.residency[0]!.readiness = 'last-known-good';
    expect(() => requireFrameMaterials(receipt, { meshMaterialBindings: [row] }, 'world', expected)).toThrow();
  });

});
