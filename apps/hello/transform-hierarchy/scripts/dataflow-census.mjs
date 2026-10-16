#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { parseReceipt, createReceipt } from './dataflow-receipt.mjs';

const FEATURE_ID = 'feat-20260901-ecs-transform-render-dataflow-rearchitecture';
const TEMPORAL_SHA = 'f8cac5f360656075ad87dd91ed5468545e25086a';
const ROOT = new URL('../../../..', import.meta.url).pathname;
const TERM_GROUPS = [
  { id: 'transform-world', pattern: 'Transform\\.world' },
  { id: 'derived-journal', pattern: 'derived-component-changed' },
  { id: 'render-operation', pattern: 'RenderSceneOperation' },
  { id: 'render-snapshot', pattern: 'RenderableSnapshot' },
  { id: 'extracted-renderables', pattern: 'ExtractedFrame.*renderables' },
];

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function matches(pattern, paths = ['packages', 'apps', 'templates', 'scripts']) {
  const result = spawnSync('rg', [
    '--json',
    '--line-number',
    '--hidden',
    '--glob', '!.git/**',
    '--glob', '!node_modules/**',
    '--glob', '!dist/**',
    '--glob', '!.forgeax-harness/**',
    pattern,
    ...paths,
  ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg census failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\n').filter(Boolean).flatMap((line) => {
    const item = JSON.parse(line);
    if (item.type !== 'match') return [];
    return [{ path: item.data.path.text, line: item.data.line_number, text: item.data.lines.text.trim() }];
  });
}

function siblingEvidence(headSha) {
  const siblingRefs = [
    { id: 'temporal-contract', mergeSha: TEMPORAL_SHA },
    { id: 'csm-shadow-multiview', mergeSha: null },
    { id: 'gpu-driven-pbr-skinning', mergeSha: null },
    { id: 'renderer-device-loss', mergeSha: null },
    { id: 'animation', mergeSha: null },
  ];
  return siblingRefs.map((sibling) => {
    if (!sibling.mergeSha) {
      return { ...sibling, status: 'unavailable', reasonCode: 'no-merge-sha', ancestor: false };
    }
    let ancestor = false;
    try {
      ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sibling.mergeSha, headSha], { cwd: ROOT }).status === 0;
    } catch {
      ancestor = false;
    }
    return { ...sibling, status: ancestor ? 'ancestor' : 'unavailable', ancestor };
  });
}

function createCensusReceipt() {
  const headSha = git(['rev-parse', 'HEAD']);
  const receipt = createReceipt({ workloadId: 'structural-churn', backend: 'git-census', frameCount: 60 });
  receipt.source = 'transform-render-consumer-census';
  receipt.featureId = FEATURE_ID;
  receipt.exactSha = headSha;
  receipt.frameIdentity = `${headSha}:census:20260901:60`;
  receipt.consumerGroups = TERM_GROUPS.map((group) => ({
    ...group,
    matches: matches(group.pattern),
  }));
  receipt.channels = {
    tsImports: matches('from [\'\"]@forgeax/engine-(scene|render|runtime|ecs)', ['packages', 'apps']),
    erasedScripts: matches('Transform|RenderScene|ExtractedFrame', ['apps/hello/transform-hierarchy/scripts', 'apps', 'packages']),
    jsonSchemas: matches('Transform|renderables|snapshot|operation', ['apps', 'packages', 'templates']),
  };
  receipt.owners = [
    { fact: 'local authored TRS', currentOwner: 'packages/scene/src/components/transform.ts', migrationTarget: 'Transform local carrier' },
    { fact: 'world transform', currentOwner: 'packages/scene/src/systems/propagate-transforms.ts', migrationTarget: 'Scene world-output carrier' },
    { fact: 'render identity', currentOwner: 'packages/render/src/scene/render-scene.ts', migrationTarget: 'Renderer GPU Scene stable numeric row' },
    { fact: 'structural changes', currentOwner: 'packages/ecs/src/world-change-journal.ts', migrationTarget: 'typed structural evidence' },
  ];
  receipt.siblings = siblingEvidence(headSha);
  receipt.unavailable = null;
  return parseReceipt(receipt);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(createCensusReceipt(), null, 2));
}
