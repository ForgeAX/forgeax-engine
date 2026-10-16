import { createVertexColorForgeaxProducer } from '../adapters/forgeax-adapter';
import { createVertexColorThreeProducer } from '../adapters/three-adapter';
import type { VertexColorBackend, VertexColorSemanticFixture } from '../contracts/types';
import {
  captureVertexColor,
  createForgeaxVertexColorCaptureSession,
  type VertexColorFalsifierMode,
  type VertexColorForgeaxBundler,
  type VertexColorCaptureSession,
} from './vertex-color-capture';

declare global {
  var __forgeaxVertexColorPublish: ((path: string, output: unknown) => Promise<void> | void) | undefined;
}

const fixtureModules = import.meta.glob('../../cases/vertex-color/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, VertexColorSemanticFixture>;

function dispatchEnvironment(): Record<string, string | undefined> {
  const processEnvironment = typeof process === 'undefined' ? {} : process.env;
  return {
    ...import.meta.env,
    ...processEnvironment,
  };
}

function parseEnvironmentMap(value: string | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `${name} must be a JSON object` }));
  }
}

function parseProducerEnvironmentMap(
  value: string | undefined,
  name: string,
): Partial<Record<'forgeax' | 'three', Record<string, string>>> {
  if (value === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    const result: Partial<Record<'forgeax' | 'three', Record<string, string>>> = {};
    for (const producer of ['forgeax', 'three'] as const) {
      const producerValue = (parsed as Record<string, unknown>)[producer];
      if (producerValue === undefined) continue;
      if (producerValue === null || typeof producerValue !== 'object' || Array.isArray(producerValue)) {
        throw new Error(`${producer} object required`);
      }
      result[producer] = Object.fromEntries(
        Object.entries(producerValue).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
    return result;
  } catch {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `${name} must be a producer map` }));
  }
}

export function vertexColorProducerIsScheduled(): boolean {
  return dispatchEnvironment().VITE_FORGEAX_VERTEX_COLOR_SCHEDULED === '1'
    || dispatchEnvironment().FORGEAX_VERTEX_COLOR_SCHEDULED === '1';
}

export async function runVertexColorProducerEntry(
  implementation: 'forgeax' | 'three',
  backend: VertexColorBackend,
  forgeaxBundler?: VertexColorForgeaxBundler,
): Promise<void> {
  const environment = dispatchEnvironment();
  const singleCaseId = environment.FORGEAX_VERTEX_COLOR_CASE_ID ?? environment.VITE_FORGEAX_VERTEX_COLOR_CASE_ID;
  const batchCaseIdsValue = environment.FORGEAX_VERTEX_COLOR_CASE_IDS ?? environment.VITE_FORGEAX_VERTEX_COLOR_CASE_IDS;
  let caseIds: string[];
  try {
    const parsed: unknown = batchCaseIdsValue === undefined ? undefined : JSON.parse(batchCaseIdsValue);
    caseIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'case IDs must be a JSON array' }));
  }
  if (caseIds.length === 0 && singleCaseId !== undefined) caseIds = [singleCaseId];
  const outputPath = environment.FORGEAX_VERTEX_COLOR_OUTPUT ?? environment.VITE_FORGEAX_VERTEX_COLOR_OUTPUT;
  const defaultOutputPaths = parseEnvironmentMap(
    environment.FORGEAX_VERTEX_COLOR_OUTPUTS ?? environment.VITE_FORGEAX_VERTEX_COLOR_OUTPUTS,
    'output paths',
  );
  const outputPathsByProducer = parseProducerEnvironmentMap(
    environment.FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER
      ?? environment.VITE_FORGEAX_VERTEX_COLOR_OUTPUTS_BY_PRODUCER,
    'producer output paths',
  );
  const outputPaths = outputPathsByProducer[implementation] ?? defaultOutputPaths;
  const falsifierOutputPaths = parseEnvironmentMap(
    environment.FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS ?? environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUTS,
    'falsifier output paths',
  );
  const falsifierOutputUrls = parseEnvironmentMap(
    environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER_OUTPUT_URLS,
    'falsifier output URLs',
  );
  const sourceSha = environment.FORGEAX_VERTEX_COLOR_SOURCE_SHA ?? environment.VITE_FORGEAX_VERTEX_COLOR_SOURCE_SHA;
  const falsifierValue = environment.FORGEAX_VERTEX_COLOR_FALSIFIER ?? environment.VITE_FORGEAX_VERTEX_COLOR_FALSIFIER;
  const vertexColorFalsifier = falsifierValue === undefined
    ? undefined
    : falsifierValue === 'white-color' || falsifierValue === 'no-color-baseline'
      ? falsifierValue as VertexColorFalsifierMode
      : undefined;
  if (falsifierValue !== undefined && vertexColorFalsifier === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `unsupported vertex-color falsifier ${falsifierValue}` }));
  }
  if (
    caseIds.length === 0
    || sourceSha === undefined
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceSha)
  ) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'case/output/source SHA environment is incomplete' }));
  }
  const publish = globalThis.__forgeaxVertexColorPublish;
  if (publish === undefined) {
    throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: 'producer output publisher is unavailable', backend, caseIds }));
  }
  let forgeaxSession: VertexColorCaptureSession | undefined;
  try {
    if (implementation === 'forgeax') {
      if (forgeaxBundler === undefined) {
        throw new Error(JSON.stringify({
          code: 'producer-entry-missing',
          detail: 'ForgeaX bundler options were not injected into the capture entry',
          recovery: 'run a producer entry with an injected shader manifest (Browser adapter or Dawn data URL)',
        }));
      }
      // Keep one renderer/device alive for the complete producer batch. Every
      // fixture still gets a fresh World and 60-frame readback, but manifest
      // fetch, device setup, and pipeline caches are paid once per backend.
      forgeaxSession = await createForgeaxVertexColorCaptureSession(forgeaxBundler);
    }
    const run = async (candidateFixture: VertexColorSemanticFixture, candidateBackend: VertexColorBackend, falsifier?: VertexColorFalsifierMode) => {
      if (forgeaxSession !== undefined) {
        return forgeaxSession.capture({
          fixture: candidateFixture,
          backend: candidateBackend,
          sourceSha,
          ...(forgeaxBundler === undefined ? {} : { forgeaxBundler }),
          ...(falsifier === undefined ? {} : { vertexColorFalsifier: falsifier }),
        });
      }
      return captureVertexColor(implementation, {
        fixture: candidateFixture,
        backend: candidateBackend,
        sourceSha,
        ...(forgeaxBundler === undefined ? {} : { forgeaxBundler }),
        ...(falsifier === undefined ? {} : { vertexColorFalsifier: falsifier }),
      });
    };
    const producer = implementation === 'forgeax'
      ? createVertexColorForgeaxProducer((fixture, candidateBackend) => run(fixture, candidateBackend, vertexColorFalsifier), sourceSha)
      : createVertexColorThreeProducer((fixture, candidateBackend) => run(fixture, candidateBackend, vertexColorFalsifier));
    for (const caseId of caseIds) {
      const fixture = fixtureModules[`../../cases/vertex-color/${caseId}.json`];
      if (fixture === undefined) {
        throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `fixture ${caseId} is unavailable` }));
      }
      const candidateOutputPath = outputPaths[caseId] ?? (caseIds.length === 1 ? outputPath : undefined);
      if (candidateOutputPath === undefined) {
        throw new Error(JSON.stringify({ code: 'producer-entry-missing', detail: `output path for ${caseId} is unavailable` }));
      }
      const output = await producer.capture(fixture, backend);
      await publish(candidateOutputPath, output);
      const candidateFalsifierOutputPath = falsifierOutputPaths[caseId];
      const candidateFalsifierOutputUrl = falsifierOutputUrls[candidateFalsifierOutputPath ?? ''];
      if (implementation === 'forgeax' && (candidateFalsifierOutputPath !== undefined || candidateFalsifierOutputUrl !== undefined)) {
        const falsifierProducer = createVertexColorForgeaxProducer(
          (falsifierFixture, falsifierBackend) => run(
            falsifierFixture,
            falsifierBackend,
            falsifierFixture.caseId === 'vertex-color-no-color-baseline' ? 'no-color-baseline' : 'white-color',
          ),
          sourceSha,
        );
        const falsifierOutput = await falsifierProducer.capture(fixture, backend);
        if (candidateFalsifierOutputPath !== undefined) await publish(candidateFalsifierOutputPath, falsifierOutput);
        if (candidateFalsifierOutputUrl !== undefined && candidateFalsifierOutputPath === undefined) await publish('__falsifier__', falsifierOutput);
      }
    }
  } finally {
    await forgeaxSession?.dispose();
  }
}
