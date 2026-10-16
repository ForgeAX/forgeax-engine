#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { heapNodes, selectedHeap } from './heap_profile.mjs';
import { emitJson, loadJson, pointer, requireFact, runCli } from './lib.mjs';
import { symbolizeNodes } from './source_maps.mjs';

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'profile-pointer': { type: 'string', default: '' },
      'digests-pointer': { type: 'string' },
      digests: { type: 'string' },
      build: { type: 'string' },
      'base-url': { type: 'string' },
      output: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'node symbolize_heap_profile.mjs INPUT --profile-pointer /profiles/1/heap --digests-pointer /profiles/1/scriptDigests --build BUILD --base-url URL [--digests FILE] [--output FILE]',
    );
    return;
  }
  requireFact(
    positionals.length === 1 &&
      values.build &&
      values['base-url'] &&
      values['digests-pointer'] !== undefined,
    'Require input, build, base URL and digests pointer',
  );
  const input = await loadJson(positionals[0]),
    build = await loadJson(values.build);
  const digests = values.digests ? await loadJson(values.digests) : input;
  const selected = selectedHeap(pointer(input.value, values['profile-pointer']));
  const nodes = heapNodes(selected.profile),
    facts = build.value;
  const buildRoot = dirname(resolve(values.build));
  const buildPath = (value) => {
    if (value === undefined) return undefined;
    requireFact(typeof value === 'string' && value.length > 0, 'Invalid build path');
    return resolve(buildRoot, value);
  };
  const mapped = await symbolizeNodes({
    nodes,
    scriptDigests: pointer(digests.value, values['digests-pointer']),
    baseUrl: values['base-url'],
    distDirectory: buildPath(facts.dist),
    engineDirectory: buildPath(facts.engineDirectory),
    distSourceDirectory: buildPath(facts.distSourceDirectory),
    engineSourceDirectory: buildPath(facts.engineSourceDirectory),
  });
  await emitJson(
    {
      kind: 'heap-source-symbols',
      inputSha256: input.sha256,
      profilePointer: values['profile-pointer'],
      digestsSha256: digests.sha256,
      digestsPointer: values['digests-pointer'],
      buildSha256: build.sha256,
      coverage: mapped.coverage,
      authenticatedFiles: mapped.authenticatedFiles,
      symbols: [...mapped.symbols].map(([nodeId, source]) => ({ nodeId, source })),
      interpretation:
        'Captured same-origin bundle bytes match script digests. Chained Engine maps authenticate each embedded intermediate source against frozen Engine output. Missing maps stay unmapped; malformed or incompatible maps fail. Local map hashes identify the supplied frozen maps, not maps captured by CDP. Source locations are one-based function locations, not exact allocation expressions. This does not qualify the capture workload.',
    },
    values.output,
    [
      ...positionals,
      values.build,
      ...(values.digests ? [values.digests] : []),
      ...mapped.authenticatedFiles.map((row) => row.path),
    ],
  );
});
