import { readFileSync } from 'node:fs';
import type {
  CatalogEntry,
  ImportedOutputDeclaration,
  ProducerContractDiagnostic,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { validateProducerOutputs } from '../producer-contract.js';

const DUPLICATE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d411';
const OTHER_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d412';

interface RecoverySignal {
  readonly authority: 'authoritative' | 'degraded';
  readonly diagnostic?: {
    readonly code: string;
    readonly hint?: string;
    readonly subject?: { readonly id?: string };
  };
}

interface RecoveryDecision {
  readonly action: 'repair-input' | 'rollback-verified-revision' | 'reject-update';
  readonly code: string;
  readonly hint: string;
}

function decideRecovery(result: RecoverySignal): RecoveryDecision {
  const diagnostic = result.diagnostic;
  if (diagnostic === undefined || diagnostic.hint === undefined) {
    return { action: 'reject-update', code: 'unknown', hint: 'keep the last verified result' };
  }
  if (result.authority === 'degraded' && diagnostic.code === 'catalog-revision-stale') {
    return {
      action: 'rollback-verified-revision',
      code: diagnostic.code,
      hint: diagnostic.hint,
    };
  }
  if (diagnostic.code === 'duplicate-source-key') {
    return { action: 'repair-input', code: diagnostic.code, hint: diagnostic.hint };
  }
  return { action: 'reject-update', code: diagnostic.code, hint: diagnostic.hint };
}

function repairDuplicateKey(
  entries: readonly CatalogEntry[],
  diagnostic: ProducerContractDiagnostic,
): readonly CatalogEntry[] {
  return entries.map((entry) =>
    entry.guid === diagnostic.subject?.id
      ? { ...entry, sourceKey: `${entry.sourceKey ?? 'output'}/repaired` }
      : entry,
  );
}

describe('AI recovery from canonical catalog fields', () => {
  it('keeps every non-current lifecycle on a safe recovery path', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../../schemas/asset-authority.schema.json', import.meta.url),
        'utf8',
      ),
    ) as {
      'x-forgeax-audit': {
        aiOperations: string[];
        recoveryByLifecycle: Record<string, string[]>;
      };
    };
    const { aiOperations, recoveryByLifecycle } = schema['x-forgeax-audit'];
    for (const lifecycle of ['missing', 'cooking', 'current', 'stale', 'failed']) {
      const actions = recoveryByLifecycle[lifecycle];
      expect(actions?.every((action) => aiOperations.includes(action))).toBe(true);
      if (lifecycle !== 'current') expect(actions?.length).toBeGreaterThan(0);
    }
    expect(aiOperations).toEqual(
      expect.arrayContaining(['inspect', 'rebuild', 'cold-cook', 'preview-LKG', 'stop-publish']),
    );
  });

  it('consumes the producer validator result and repairs a duplicate key', () => {
    const outputs: ImportedOutputDeclaration[] = [
      { guid: DUPLICATE_GUID, kind: 'nebula/fragment', sourceKey: 'fragment/main', sourceIndex: 0 },
      { guid: OTHER_GUID, kind: 'nebula/fragment', sourceKey: 'fragment/main', sourceIndex: 1 },
    ];
    const contract = validateProducerOutputs(outputs);
    expect(contract.ok).toBe(false);
    if (contract.ok) return;

    const decision = decideRecovery({ authority: 'degraded', diagnostic: contract.error });
    expect(decision).toMatchObject({ action: 'repair-input', code: contract.error.code });
    const entries: CatalogEntry[] = outputs.map((output) => ({
      guid: output.guid,
      packageUrl: '/duplicate/main.pack.json',
      sourcePath: 'duplicate.pack.json',
      kind: output.kind,
      packageId: 'pkg/ai-recovery',
      ...(output.sourceKey === undefined ? {} : { sourceKey: output.sourceKey }),
      sourceIndex: output.sourceIndex,
    }));
    const repairedEntries = repairDuplicateKey(entries, contract.error);
    expect(new Set(repairedEntries.map((entry) => entry.sourceKey)).size).toBe(2);
    expect(decision.hint).toBe(contract.error.hint);
    const repaired = repairedEntries.map((entry) => {
      if (entry.sourceKey === undefined || entry.sourceIndex === undefined) {
        throw new Error(`repaired catalog row ${entry.guid} lost output topology`);
      }
      return {
        guid: entry.guid,
        kind: entry.kind,
        sourceKey: entry.sourceKey,
        sourceIndex: entry.sourceIndex,
      };
    });
    expect(validateProducerOutputs(repaired)).toMatchObject({ ok: true });
  });
});
