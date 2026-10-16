import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildMaterialAcceptanceVerdict,
  buildReceipt,
  compactFixtureIdentity,
  compareCompactFixtureToLive,
  hasRealMaterialEvidence,
  parseSmokeOutput,
  runMaterialWitness,
  validateMaterialAcceptanceDeclaration,
} from '../material-fleet-smoke.mjs';

const COMPACT_IDENTITY = {
  layoutIdentity: 'layout',
  programIdentity: 'program',
  pipelineIdentity: 'pipeline',
  cookIdentity: 'cook',
  compilerFingerprint: 'compiler',
  artifactDigest: 'artifact',
  materialPublicationIdentity: 'publication',
  valueGeneration: 1,
  dependencyGeneration: 1,
  cookGeneration: 1,
  wasm: { sourceContentKey: 'source', artifactSha256: 'artifact-sha', glueSha256: 'glue-sha' },
};

const RUNTIME_RECEIPT = JSON.parse(
  readFileSync(
    new URL('../material-witness-fixtures/runtime.receipt.json', import.meta.url),
    'utf8',
  ),
);

function compactReceipt() {
  return {
    schemaVersion: 'material-witness-receipt/1',
    kind: 'material-witness-receipt',
    sourceKind: 'gltf',
    materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
    rootGuid: '01935b00-7d8c-7c4e-9f12-345678abcd03',
    rootPublication: {
      guid: '01935b00-7d8c-7c4e-9f12-345678abcd03',
      format: 'ts',
      path: 'templates/game-3d/assets/materials.pack.ts',
      sourceKey: 'material/standard-root',
    },
    child: { authoredKeys: ['kind', 'parent', 'values'], forbiddenFields: [] },
    receipt: {
      identity: { ...COMPACT_IDENTITY, wasm: { ...COMPACT_IDENTITY.wasm } },
    },
    artifactDigest: 'artifact',
    sourceClosure: ['packages/shader/src/default-standard-pbr.wgsl', 'forgeax::module'],
  };
}

describe('material fleet smoke receipt parsing', () => {
  it('validates a compact receipt and rejects stale live identity', () => {
    const fixture = compactReceipt();
    const witness = { materialGuid: fixture.materialGuid };
    expect(compactFixtureIdentity(fixture, witness)).toMatchObject({
      schemaVersion: 'material-witness-receipt/1',
      materialGuid: fixture.materialGuid,
      rootGuid: fixture.rootGuid,
      rootPublication: fixture.rootPublication,
    });
    const live = {
      rootGuid: fixture.rootGuid,
      rootPublication: fixture.rootPublication,
      source: fixture.sourceClosure,
      materialIdentity: { ...COMPACT_IDENTITY, materialGuid: fixture.materialGuid },
    };
    expect(compareCompactFixtureToLive(compactFixtureIdentity(fixture, witness), live)).toEqual([]);
    expect(
      compareCompactFixtureToLive(compactFixtureIdentity(fixture, witness), {
        ...live,
        materialIdentity: { ...live.materialIdentity, cookIdentity: 'stale' },
      }),
    ).toContain('stale fixture identity cookIdentity');
  });

  it('rejects value-only publication and generation drift', () => {
    const fixture = compactReceipt();
    const compact = compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid });
    const live = {
      rootGuid: fixture.rootGuid,
      rootPublication: fixture.rootPublication,
      source: fixture.sourceClosure,
      materialIdentity: { ...COMPACT_IDENTITY, materialGuid: fixture.materialGuid },
    };

    for (const [field, value] of [
      ['materialPublicationIdentity', 'stale-publication'],
      ['valueGeneration', 2],
      ['dependencyGeneration', 2],
      ['cookGeneration', 2],
    ]) {
      expect(
        compareCompactFixtureToLive(compact, {
          ...live,
          materialIdentity: { ...live.materialIdentity, [field]: value },
        }),
      ).toContain(`stale fixture identity ${field}`);
    }
  });

  it('requires every expanded field in compact receipt identities', () => {
    for (const field of [
      'materialPublicationIdentity',
      'valueGeneration',
      'dependencyGeneration',
      'cookGeneration',
    ]) {
      const fixture = compactReceipt();
      delete fixture.receipt.identity[field];
      expect(
        compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid }).error,
      ).toContain(`fixture receipt identity lacks ${field}`);
    }
  });

  it('requires generations to be safe positive integers', () => {
    for (const field of ['valueGeneration', 'dependencyGeneration', 'cookGeneration']) {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const fixture = compactReceipt();
        fixture.receipt.identity[field] = value;
        expect(
          compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid }).error,
        ).toContain(`fixture receipt identity lacks ${field}`);
      }

      const fixture = compactReceipt();
      fixture.receipt.identity[field] = 1;
      expect(
        compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid }),
      ).not.toHaveProperty('error');
    }
  });

  it('fails closed without throwing for malformed material or root GUIDs', () => {
    for (const field of ['materialGuid', 'rootGuid']) {
      const fixture = compactReceipt();
      fixture[field] = undefined;
      expect(() =>
        compactFixtureIdentity(fixture, { materialGuid: compactReceipt().materialGuid }),
      ).not.toThrow();
      expect(
        compactFixtureIdentity(fixture, { materialGuid: compactReceipt().materialGuid }).error,
      ).toContain(`fixture ${field} is invalid`);
    }
  });

  it('requires exact root publication provenance and source closure from live output', () => {
    const fixture = compactReceipt();
    const compact = compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid });
    const live = {
      rootGuid: fixture.rootGuid,
      rootPublication: fixture.rootPublication,
      source: fixture.sourceClosure,
      materialIdentity: { ...COMPACT_IDENTITY, materialGuid: fixture.materialGuid },
    };

    const { rootPublication: _missingRootPublication, ...withoutRootPublication } = live;
    expect(compareCompactFixtureToLive(compact, withoutRootPublication)).toContain(
      'live rootPublication is missing',
    );
    expect(
      compareCompactFixtureToLive(compact, {
        ...live,
        rootPublication: { ...fixture.rootPublication, sourceKey: 'material/other-root' },
      }),
    ).toContain('stale fixture rootPublication sourceKey');
    const { source: _missingSourceClosure, ...withoutSourceClosure } = live;
    expect(compareCompactFixtureToLive(compact, withoutSourceClosure)).toContain(
      'live sourceClosure is missing',
    );
  });

  it('rejects a parent child receipt that retains root-owned fields', () => {
    const fixture = compactReceipt();
    fixture.child = {
      authoredKeys: ['colorSpace', 'kind', 'parent', 'values'],
      forbiddenFields: ['colorSpace'],
    };
    expect(compactFixtureIdentity(fixture, { materialGuid: fixture.materialGuid }).error).toContain(
      'authoredKeys must equal kind,parent,values',
    );
  });

  it('recognizes the established 300-frame PASS output forms', () => {
    const parsed = parseSmokeOutput(
      [
        '[smoke] rendered 300 frames',
        '[smoke] frames observed=300',
        '[smoke] result={"frames":300}',
        '[smoke] PASS - RhiError count=0, deferred-to-PR for AC-09',
      ].join('\n'),
      '',
    );

    expect(parsed.frameCount).toBe(300);
    expect(parsed.criterion).toBe('structural');
    expect(parsed.markers).toEqual([]);
  });

  it('extracts quoted JSON keys from prefixed PASS output', () => {
    const parsed = parseSmokeOutput(
      '[smoke-dawn] PASS {"frames":300,"structural":true,"pixelSamples":{"center":1}}',
      '',
    );

    expect(parsed.frameCount).toBe(300);
    expect(parsed.criterion).toBe('pixel');
    expect(parsed.markers).toEqual([]);
  });

  it('retains real material contract failures as receipt markers', () => {
    const parsed = parseSmokeOutput(
      '[RhiError material-derived-interface-mismatch] expected: generated interface',
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.markers).toEqual([
      '[RhiError material-derived-interface-mismatch] expected: generated interface',
    ]);
  });

  it('trusts M7 app-owned device-loss evidence after its recovery oracle passes', () => {
    const parsed = parseSmokeOutput(
      [
        '[RhiError device-lost] expected: device must remain alive',
        '[m7-browser-device-loss] PASS - driver=Browser.crashGpuProcess',
        '[m7-backend] PASS - M7 backend/recovery evidence GREEN',
      ].join('\n'),
      '',
    );

    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('does not convert low-frame output into a false pass', () => {
    const parsed = parseSmokeOutput('[smoke] frames observed=60', '');

    expect(parsed.frameCount).toBe(60);
    expect(parsed.criterion).toBe('unreported');
    expect(parsed.markers).toEqual([]);
  });

  it('accepts an app-owned PASS oracle when the app deliberately does not report a frame count', () => {
    const parsed = parseSmokeOutput(
      '[m1-composition] PASS - schedule and lifecycle gates GREEN',
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('accepts a successful JSON app oracle without a textual frame count', () => {
    const parsed = parseSmokeOutput(
      JSON.stringify({ ok: true, reports: [{ tier: 'main-serial' }] }),
      '',
    );

    expect(parsed.frameCount).toBe(0);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.declaredPass).toBe(true);
    expect(parsed.markers).toEqual([]);
  });

  it('does not turn an expected composite falsifier into a gate failure', () => {
    const parsed = parseSmokeOutput(
      [
        '[smoke] FAIL - low mode frame 60 has zero foreground pixels',
        '[m5-interactive] debug-draw falsifier: PASS (expected non-zero falsifier)',
        '[m5-interactive] PASS - M5 interaction/media gates GREEN',
      ].join('\n'),
      '',
    );

    expect(parsed.expectedFalsifierPass).toBe(true);
    expect(parsed.criterion).toBe('declared');
    expect(parsed.markers).toEqual([]);
  });

  it('requires a producer declaration for every material witness', () => {
    const declaration = {
      schemaVersion: 1,
      kind: 'material-acceptance-declaration',
      producer: 'fixture-producer',
      requiredCategories: ['custom-dawn', 'custom-browser'],
      witnesses: [
        {
          id: 'custom-dawn',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'dawn',
          category: 'custom-dawn',
          command: { program: 'node', args: ['smoke-dawn.mjs'] },
        },
        {
          id: 'custom-browser',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'browser',
          category: 'custom-browser',
          command: { program: 'node', args: ['smoke-browser.mjs'] },
        },
      ],
    };

    expect(validateMaterialAcceptanceDeclaration(declaration, () => true)).toMatchObject({
      ok: true,
      errors: [],
    });

    const verdict = buildMaterialAcceptanceVerdict(declaration, [
      {
        witnessId: 'custom-dawn',
        verdict: 'pass',
        evidence: { materialIdentity: { materialGuid: declaration.witnesses[0].materialGuid } },
      },
    ]);
    expect(verdict.verdict).toBe('fail');
    expect(verdict.missingWitnesses).toEqual(['custom-browser']);
  });

  it('keeps material and repository verdicts independent', () => {
    const declaration = {
      schemaVersion: 1,
      kind: 'material-acceptance-declaration',
      producer: 'fixture-producer',
      requiredCategories: ['custom-dawn'],
      witnesses: [
        {
          id: 'custom-dawn',
          subject: 'custom shader',
          fixture: 'fixture.pack.json',
          materialGuid: '01935b00-7d8c-7c4e-9f12-345678abcd02',
          evidence: 'dawn',
          category: 'custom-dawn',
          command: { program: 'node', args: ['smoke-dawn.mjs'] },
        },
      ],
    };
    const material = buildMaterialAcceptanceVerdict(declaration, [
      {
        witnessId: 'custom-dawn',
        verdict: 'pass',
        evidence: { materialIdentity: { materialGuid: declaration.witnesses[0].materialGuid } },
      },
    ]);
    const receipt = buildReceipt(
      'revision',
      [{ app: 'apps/hello/unrelated', required: true, verdict: 'fail' }],
      { declaration, material },
    );

    expect(receipt.materialAcceptanceVerdict).toBe('pass');
    expect(receipt.repositoryRegressionVerdict).toBe('fail');
    expect(receipt.verdict).toBe('fail');
  });

  it('requires canonical browser readback and decoded pixel fields', () => {
    const guid = '01935b00-7d8c-7c4e-9f12-345678abcd02';
    const base = {
      browserPath: true,
      webgpu: true,
      materialIdentity: {
        materialGuid: guid,
        compilerFingerprint: 'compiler',
        artifactDigest: 'artifact',
        cookIdentity: 'cook',
        layoutIdentity: 'layout',
        materialContractDigest: 'contract',
        materialPublicationIdentity: 'publication',
        pipelineIdentity: 'pipeline',
        programIdentity: 'program',
        valueGeneration: 1,
        dependencyGeneration: 1,
        cookGeneration: 1,
      },
      readback: { status: 'ok', nonZeroBytes: 4, nonZeroAlphaPixels: 1 },
      pixel: [0.2, 0.1, 0, 1],
    };
    expect(hasRealMaterialEvidence(base, 'browser')).toBe(true);
    expect(hasRealMaterialEvidence({ ...base, pixel: undefined }, 'browser')).toBe(false);
  });

  it('accepts real browser and Dawn evidence with core identity only', () => {
    const guid = '01935b00-7d8c-7c4e-9f12-345678abcd02';
    const coreIdentity = {
      materialGuid: guid,
      compilerFingerprint: 'compiler',
      artifactDigest: 'artifact',
      cookIdentity: 'cook',
      layoutIdentity: 'layout',
      pipelineIdentity: 'pipeline',
      programIdentity: 'program',
    };
    expect(
      hasRealMaterialEvidence(
        {
          browserPath: true,
          webgpu: true,
          materialIdentity: coreIdentity,
          readback: { status: 'ok', nonZeroBytes: 4, nonZeroAlphaPixels: 1 },
          pixel: [0.2, 0.1, 0, 1],
        },
        'browser',
      ),
    ).toBe(true);
    expect(
      hasRealMaterialEvidence(
        { frames: 300, materialIdentity: coreIdentity, pixel: [0.2, 0.1, 0, 1] },
        'dawn',
      ),
    ).toBe(true);
  });

  it('retains pass identity when cleanup fails without upgrading the verdict', async () => {
    const pass = {
      status: 'pass',
      frames: 300,
      pixel: [0.2, 0.1, 0, 1],
      materialIdentity: {
        ...RUNTIME_RECEIPT.receipt.identity,
        materialGuid: RUNTIME_RECEIPT.materialGuid,
      },
      rootGuid: RUNTIME_RECEIPT.rootGuid,
      source: RUNTIME_RECEIPT.sourceClosure,
    };
    const cleanup = {
      cleanup: { complete: false, remainingTreePids: [1234], remainingListenerPids: [1234] },
      error: 'browser close timed out after 15000ms',
    };
    const result = await runMaterialWitness({
      id: 'cleanup-failure',
      category: 'custom-dawn',
      evidence: 'dawn',
      fixture: 'scripts/forgeax/material-witness-fixtures/runtime.receipt.json',
      materialGuid: RUNTIME_RECEIPT.materialGuid,
      command: {
        program: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(`${JSON.stringify(pass)}\n`)}); process.stderr.write(${JSON.stringify(`${JSON.stringify(cleanup)}\n`)}); process.exitCode = 1;`,
        ],
      },
    });

    expect(result.verdict).toBe('fail');
    expect(result.errors).toContain('command exited with 1');
    expect(result.evidence.materialIdentity).toMatchObject({
      materialGuid: RUNTIME_RECEIPT.materialGuid,
      cookIdentity: RUNTIME_RECEIPT.receipt.identity.cookIdentity,
    });
  });
});
