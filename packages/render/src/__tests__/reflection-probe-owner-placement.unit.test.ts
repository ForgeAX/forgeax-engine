import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const renderSystemPath = fileURLToPath(new URL('../render-system.ts', import.meta.url));
const recordOwnerPath = fileURLToPath(new URL('../reflection/record-owner.ts', import.meta.url));
const renderSystemSource = readFileSync(renderSystemPath, 'utf8');
const reflectionSystemsPath = fileURLToPath(
  new URL('../world/reflection-systems.ts', import.meta.url),
);
const reflectionSystemsSource = readFileSync(reflectionSystemsPath, 'utf8');
const rendererSource = readFileSync(
  fileURLToPath(new URL('../assembly/renderer-inspection.ts', import.meta.url)),
  'utf8',
);
const recordOwnerSource = existsSync(recordOwnerPath) ? readFileSync(recordOwnerPath, 'utf8') : '';

describe('ReflectionProbe owner placement', () => {
  it('defines the owner exactly once under the reflection cluster', () => {
    expect(existsSync(recordOwnerPath)).toBe(true);
    expect(recordOwnerSource.match(/export class ReflectionProbeRecordOwner/g)).toHaveLength(1);
    expect(renderSystemSource).not.toMatch(/class ReflectionProbeRecordOwner/);
    expect(renderSystemSource).toContain(
      "import { ReflectionProbeRecordOwner } from './reflection/record-owner';",
    );
  });

  it('assembles the owner in render-system and prepares it only in view-reflection-probes', () => {
    expect(renderSystemSource.match(/new ReflectionProbeRecordOwner\(internals\)/g)).toHaveLength(
      1,
    );
    expect(recordOwnerSource.match(/new ReflectionProbeRecordOwner\(/g)).toBeNull();
    expect(renderSystemSource).toContain('reflectionProbes: reflectionProbeOwner');
    expect(renderSystemSource).not.toContain('reflectionProbeOwner.prepare(');
    expect(reflectionSystemsSource.match(/owner\.reflectionProbes\.prepare\(/g)).toHaveLength(1);
    // Inspection reads the inspected view owner's probes.
    expect(rendererSource).toContain('reflectionProbes: inspected.reflectionProbes.inspect()');
    expect(renderSystemSource).toContain('reflectionProbeOwner.dispose()');
  });

  it('rejects a parallel SSR owner, cache, or commit ledger vocabulary', () => {
    const combinedSource = `${renderSystemSource}\n${recordOwnerSource}\n${reflectionSystemsSource}`;
    expect(combinedSource).not.toMatch(/\bSsrProbeManager\b/);
    expect(combinedSource).not.toMatch(/\bSsrEnvironmentCache\b/);
    expect(combinedSource).not.toMatch(
      /\b(?:Ssr|SSR)(?:Probe|Environment).*(?:Ledger|Cache|Manager)\b/,
    );
    expect(combinedSource).not.toMatch(/\bcommitLedger\b/);
  });
});
