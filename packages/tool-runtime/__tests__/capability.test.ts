import { describe, expect, it } from 'vitest';
import {
  createRealmCapabilityMatrix,
  validateRealmBootstrapPayload,
} from '../src/capability.js';
import { createToolRuntime, defineTool, defineToolCapability } from '../src/index.js';

const answerCapability = defineToolCapability<{ readonly value: number }>('fixture.answer');

describe('realm capability contract', () => {
  it('publishes one explicit capability entry for each supported realm', () => {
    const matrix = createRealmCapabilityMatrix({
      catalogDigest: 'sha256:catalog',
      supported: { build: true, host: true, engine: true, frontend: true },
    });

    expect(matrix).toEqual({
      catalogDigest: 'sha256:catalog',
      realms: {
        build: { realm: 'build', supported: true },
        host: { realm: 'host', supported: true },
        engine: { realm: 'engine', supported: true },
        frontend: { realm: 'frontend', supported: true },
      },
    });
  });

  it('refuses a non-clone-safe bootstrap payload before module evaluation', () => {
    const liveHandle = { port: new MessageChannel().port1 };
    expect(validateRealmBootstrapPayload(liveHandle)).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'tool-bootstrap-not-clone-safe' }),
    });
  });

  it('resolves a typed capability only through the execution context', async () => {
    const answer = { value: 42 };
    const contribution = defineTool(
      {
        id: 'fixture.capability',
        title: 'Capability fixture',
        summary: 'Consumes one host capability.',
        realm: 'host',
        argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        evidence: [],
      },
      (_value, context) => {
        const resolved = context.require(answerCapability);
        return resolved.ok ? resolved.value.value : resolved;
      },
    );

    const terminal = await createToolRuntime([contribution]).run(contribution, null, {
      capabilityResolver: () => ({ ok: true as const, value: answer }),
    }).terminal;
    expect(terminal).toMatchObject({ outcome: 'succeeded', result: 42 });
  });

  it('returns a closed failure when a capability is not registered', async () => {
    const contribution = defineTool(
      {
        id: 'fixture.missing-capability',
        title: 'Missing capability fixture',
        summary: 'Requests an unavailable host capability.',
        realm: 'host',
        argsSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        resultSchema: { parse: (value: unknown) => ({ ok: true as const, value }) },
        evidence: [],
      },
      (_value, context) => context.require(answerCapability),
    );

    const terminal = await createToolRuntime([contribution]).run(contribution, null).terminal;
    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-capability-unavailable',
        detail: { capability: 'fixture.answer', realm: 'host' },
      },
    });
  });
});
