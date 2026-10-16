import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shadowPassPath = fileURLToPath(
  new URL('../../../render/src/record/shadow-pass.ts', import.meta.url),
);
const shadowPass = readFileSync(shadowPassPath, 'utf8');

function sourceAfter(signature: string): string {
  const start = shadowPass.indexOf(signature);
  expect(start).toBeGreaterThanOrEqual(0);
  return shadowPass.slice(start);
}

function expectValidatedOrderedLoop(signature: string, indexName: string): void {
  const body = sourceAfter(signature);
  expect(body).toContain(
    'const validatedOrdered = shadowValidatedOrdered ?? mainValidatedOrdered;',
  );
  expect(body).toContain(
    `for (let ${indexName} = 0; ${indexName} < validatedOrdered.length; ${indexName}++)`,
  );
  expect(body).toContain(`const entry = validatedOrdered[${indexName}];`);
  expect(body).toContain(
    'if (matchedIndices !== null && !matchedIndices.has(entry.renderableIndex)) continue;',
  );
  expect(body).toContain('const meshSsboBase = c.shadowMeshSsboBase ?? 0');
  expect(body).toContain(`(meshSsboBase + ${indexName}) * MESH_PER_ENTITY_STRIDE`);
}

describe('shadow mesh SSBO order', () => {
  it('uses the upload order for typed directional, point, and spot shadow offsets', () => {
    expectValidatedOrderedLoop('function recordShadowCasterDraws(', 'i');
    expect(shadowPass).toContain('export function encodeDirectionalShadowPass(');
    expect(shadowPass).toContain('export function encodePointShadowPass(');
    expect(shadowPass).toContain('export function encodeSpotShadowPass(');
    const spotBody = sourceAfter('export function encodeSpotShadowPass(');
    expect(spotBody).toContain('recordShadowCasterDraws(');
    expect(spotBody).toContain(
      'const dispatchProjection = shadowResidualSelection(c, claimedKeys);',
    );
    expect(spotBody).toContain('dispatchProjection.matchedIndices');
    expect(spotBody).toContain('dispatchProjection.matchedMaterialHandles');
    expect(shadowPass).not.toContain('export function recordShadowPass(');
    expect(shadowPass).not.toContain('export function recordPointShadowPass(');
    expect(shadowPass).not.toContain('export function recordSpotShadowPass(');
    expect(shadowPass).not.toContain('function recordSpotShadowGeometry(');
  });
});
