import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const engineRoot = process.cwd();
const editorRootArg = process.argv.indexOf('--editor-root');
const editorRoot = editorRootArg < 0 ? undefined : process.argv[editorRootArg + 1];

if (editorRootArg >= 0 && editorRoot === undefined) {
  console.error(
    'usage: node scripts/forgeax/check-catalog-docs.mjs [--editor-root /absolute/path/to/forgeax-editor]',
  );
  process.exit(2);
}

const engineDocuments = [
  [
    'packages/assets-runtime/README.md',
    [
      'CatalogSource',
      'subscribeCatalog',
      'enumerateCatalog',
      'listCatalog',
      'configureRuntimeBinding',
      'load(guid, kind, { signal }?)',
      'read(handle)',
      'update(handle, patch)',
      'snapshot(handle)',
      'reload(handle, { conflict })',
      'asset-write-conflict',
      'AssetEvidence',
      'packageUrl',
      'stale',
      'unknown',
      'inspect(guid)',
      'verifyByGuid(guid)',
    ],
  ],
  [
    'packages/vite-plugin-pack/README.md',
    [
      'pluginPack',
      'reloadAssetHost()',
      'createCatalogClient',
      'producerReadiness',
      'runtimeBinding',
      'sourceKey',
      'generation',
      'structured failure',
      'lastKnownGood',
      'preview-LKG',
      'AssetEvidence',
      'packageUrl',
      'notCooked',
      'stale',
      'unknown',
      'lookup/verify --guid --project --catalog --json',
    ],
  ],
  [
    'skills/forgeax-engine-assets/SKILL.md',
    [
      'CatalogSource',
      'CatalogDelta',
      'subscribeCatalog',
      'enumerateCatalog',
      'pluginPack',
      'createCatalogClient',
      'reloadAssetHost()',
      'runtimeBinding',
      'generation',
      'sourceKey',
      'editor pinned consumer',
      'AssetEvidence',
      'packageUrl',
      'notCooked',
      'stale',
      'unknown',
      'lookup/verify --guid --project --catalog --json',
    ],
  ],
  ...[
    'packages/types/README.md',
    'packages/pack/README.md',
    'packages/image/README.md',
    'packages/gltf/README.md',
    'packages/fbx/README.md',
    'packages/ui/README.md',
    'packages/audio-webaudio/README.md',
  ].map((path) => [
    path,
    [
      'AssetEvidence',
      'packageUrl',
      'notCooked',
      'stale',
      'unknown',
      'lookup/verify --guid --project --catalog --json',
    ],
  ]),
  [
    'packages/font/README.md',
    [
      "assets.load(fontGuid, 'font')",
      'fontContribution',
      'Cook/Catalog',
      'managed references',
      '../assets-runtime/README.md',
    ],
  ],
];

const materialDocuments = [
  ['packages/types/README.md', 'MaterialAsset route'],
  ['packages/pack/README.md', 'MaterialAsset cook contract'],
  ['packages/shader/README.md', 'MaterialAsset and shader route'],
  ['packages/assets-runtime/README.md', 'MaterialAsset runtime recovery'],
  ['packages/gltf/README.md', 'glTF material output'],
  ['packages/render/README.md', 'MaterialAsset render contract'],
  ['skills/forgeax-engine-material/SKILL.md', 'Mental model'],
  ['skills/forgeax-engine-shader/SKILL.md', 'Route'],
  ['skills/forgeax-engine-assets/SKILL.md', 'Material assets follow'],
  ['rules/forgeax-engine-usage.md', 'MaterialAsset route'],
];

const materialRecoveryCodes = [
  'material-specialization-not-cooked',
  'material-parent-not-found',
  'material-value-type-mismatch',
  'material-reflection-binding-mismatch',
];

const standardLightingDocuments = [
  [
    'packages/render/README.md',
    ['forgeax::standard', 'LightFrame', 'standard-cluster-transport-unavailable'],
  ],
  ['packages/shader/README.md', ['evaluateStandardClusterLights', 'standard-cluster.wgsl']],
  ['packages/runtime/README.md', ['standard-profile-invalid', 'renderPath']],
];

async function checkStandardLightingDocuments(root) {
  const failures = [];
  for (const [relativePath, tokens] of standardLightingDocuments) {
    const source = await readFile(resolve(root, relativePath), 'utf8');
    for (const token of tokens) {
      if (!source.includes(token))
        failures.push(
          `engine/${relativePath}: add Standard lighting guidance ${JSON.stringify(token)}`,
        );
    }
  }
  return failures;
}

const authorityAuditVocabulary = [
  'subject',
  'execution',
  'lifecycle',
  'lastKnownGood',
  'sourceKey',
  'producerReadiness',
  'runtimeBinding',
  'generation',
  'author authority',
  'runtime source',
  'author-validation',
  'external-declaration',
  'import',
  'native-cook',
  'ddc-validation',
  'runtime-parse',
  'editor-capability',
  'inspect',
  'rebuild',
  'cold cook',
  'preview-LKG',
  'override',
  'promote',
  'stop-publish',
];
const authorityAuditDocuments = [
  'packages/pack/README.md',
  'packages/import/README.md',
  'packages/vite-plugin-pack/README.md',
  'packages/assets-runtime/README.md',
  'packages/vfx/README.md',
  'packages/vfx-compiler/README.md',
  'packages/ddc/README.md',
  'packages/devkit/README.md',
];
const materialRouteTokens = [
  'MaterialAsset',
  'passes',
  'values',
  'parent',
  'coordinates',
  'cook',
  'recovery',
];
const retiredMaterialTerms = ['ShaderAsset', 'paramValues', 'uvSet', 'registerMaterial', 'sidecar'];

async function checkMaterialDocuments(root) {
  const failures = [];
  for (const [relativePath, anchor] of materialDocuments) {
    const absolutePath = resolve(root, relativePath);
    let source;
    try {
      source = await readFile(absolutePath, 'utf8');
    } catch (error) {
      failures.push(
        `engine/${relativePath}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const anchorIndex = source.indexOf(anchor);
    if (anchorIndex < 0) {
      failures.push(
        `engine/${relativePath}: add the MaterialAsset route anchor ${JSON.stringify(anchor)}`,
      );
      continue;
    }
    const route = source.slice(anchorIndex, anchorIndex + 700);
    for (const token of materialRouteTokens) {
      if (!route.includes(token))
        failures.push(
          `engine/${relativePath}: add material route guidance ${JSON.stringify(token)}`,
        );
    }
    for (const token of retiredMaterialTerms) {
      if (route.includes(token))
        failures.push(
          `engine/${relativePath}: remove retired material term ${JSON.stringify(token)}`,
        );
    }
    if (relativePath === 'packages/assets-runtime/README.md') {
      for (const token of materialRecoveryCodes) {
        if (!source.includes(token))
          failures.push(`engine/${relativePath}: document recovery code ${JSON.stringify(token)}`);
      }
    }
    const links = [...route.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
    for (const link of links) {
      if (
        link.startsWith('http://') ||
        link.startsWith('https://') ||
        link.startsWith('#') ||
        link.startsWith('../../commit/')
      )
        continue;
      const target = resolve(absolutePath, '..', link.split('#', 1)[0]);
      try {
        await access(target);
      } catch {
        failures.push(`engine/${relativePath}: broken material route link ${JSON.stringify(link)}`);
      }
    }
  }
  try {
    await access(resolve(root, 'scripts/__tests__/catalog-documentation-material.test.mjs'));
  } catch {
    failures.push(
      'engine/scripts/__tests__/catalog-documentation-material.test.mjs: missing material catalog test',
    );
  }
  return failures;
}

const editorDocuments = [
  ['packages/core/README.md', ['CatalogDelta', 'subscribe to', 'enumerate', 'GUID', 'pinned']],
  [
    'packages/content-browser/README.md',
    ['CatalogDelta', 'subscribe first', 'GUID', 'reload policy'],
  ],
  [
    'packages/edit-runtime/README.md',
    ['CatalogSource', 'CatalogDelta', 'subscribe before enumerating', 'submodule pin'],
  ],
];

async function checkDocuments(root, documents, label) {
  const failures = [];
  for (const [relativePath, required] of documents) {
    const absolutePath = resolve(root, relativePath);
    let source;
    try {
      source = await readFile(absolutePath, 'utf8');
    } catch (error) {
      failures.push(
        `${label}/${relativePath}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    for (const token of required) {
      if (!source.includes(token))
        failures.push(`${label}/${relativePath}: add catalog guidance ${JSON.stringify(token)}`);
    }
  }
  return failures;
}

async function checkVitePluginPackSurface(root) {
  const relativePath = 'packages/vite-plugin-pack/README.md';
  const absolutePath = resolve(root, relativePath);
  const failures = [];
  let source;
  try {
    source = await readFile(absolutePath, 'utf8');
  } catch (error) {
    return [
      'engine/' +
        relativePath +
        ': unreadable (' +
        (error instanceof Error ? error.message : String(error)) +
        ')',
    ];
  }

  for (const token of [
    'pluginPack',
    'reloadAssetHost()',
    'createCatalogClient',
    'producerReadiness',
    'runtimeBinding',
    'sourceKey',
    'generation',
    'structured failure',
    'lastKnownGood',
    'preview-LKG',
  ]) {
    if (!source.includes(token))
      failures.push(
        `engine/${relativePath}: add narrow recovery guidance ${JSON.stringify(token)}`,
      );
  }

  for (const token of [
    'buildCatalog()',
    'createCatalogSource',
    'createDevImportTransport',
    'importTransport',
    'forgeax:catalog-delta',
    '/__pack/',
    '/__import/',
    'event replay',
    'route wiring',
    'source-compatible',
  ]) {
    if (source.includes(token))
      failures.push(`engine/${relativePath}: remove retired public term ${JSON.stringify(token)}`);
  }
  return failures;
}

async function checkAuthorityAuditContract(root) {
  const failures = [];
  const schemaPath = resolve(root, 'schemas/asset-authority.schema.json');
  let schemaSource;
  try {
    schemaSource = await readFile(schemaPath, 'utf8');
    JSON.parse(schemaSource);
  } catch (error) {
    failures.push(
      `engine/schemas/asset-authority.schema.json: unreadable or invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return failures;
  }
  for (const token of ['"subject"', '"execution"', '"lifecycle"', '"sourceKey"']) {
    if (!schemaSource.includes(token))
      failures.push(
        `engine/schemas/asset-authority.schema.json: add audit field ${JSON.stringify(token)}`,
      );
  }
  const authoritySources = [schemaSource];
  for (const relativePath of authorityAuditDocuments) {
    const absolutePath = resolve(root, relativePath);
    let source;
    try {
      source = await readFile(absolutePath, 'utf8');
    } catch (error) {
      failures.push(
        `engine/${relativePath}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    authoritySources.push(source);
    if (!source.includes('schemas/asset-authority.schema.json'))
      failures.push(`engine/${relativePath}: link the authority audit schema`);
    if (!/lifecycle/i.test(source))
      failures.push(`engine/${relativePath}: document lifecycle evidence`);
    if (!/runtime/i.test(source))
      failures.push(`engine/${relativePath}: document the runtime boundary`);
  }
  const authorityCorpus = authoritySources.join('\n');
  for (const token of authorityAuditVocabulary) {
    if (!authorityCorpus.includes(token))
      failures.push(
        `engine/schemas/asset-authority.schema.json: add audit vocabulary ${JSON.stringify(token)}`,
      );
  }
  return failures;
}

async function checkScriptablePackMatrix(root) {
  const failures = [];
  const matrixSource = await readFile(
    resolve(root, 'packages/pack/src/scriptable-pack.ts'),
    'utf8',
  );
  const matrixBody = matrixSource.match(
    /SCRIPTABLE_PACK_ASSET_KINDS\s*=\s*\[([\s\S]*?)\]\s+as const/,
  )?.[1];
  const kinds = [...(matrixBody?.matchAll(/'([^']+)'/g) ?? [])].map((match) => match[1]);
  if (kinds.length === 0) {
    failures.push(
      'engine/packages/pack/src/scriptable-pack.ts: could not read SCRIPTABLE_PACK_ASSET_KINDS',
    );
    return failures;
  }
  const matrixDocuments = [
    'packages/types/README.md',
    'packages/assets-runtime/README.md',
    'packages/pack/README.md',
    'packages/import/README.md',
    'packages/vite-plugin-pack/README.md',
  ];
  for (const relativePath of matrixDocuments) {
    const source = await readFile(resolve(root, relativePath), 'utf8');
    if (relativePath === 'packages/assets-runtime/README.md') {
      if (!source.includes('../pack/README.md#scriptablepack-in-30-seconds'))
        failures.push(`engine/${relativePath}: link the owning ScriptablePack kind matrix`);
      continue;
    }
    for (const kind of kinds) {
      if (!source.includes(kind)) {
        failures.push(
          `engine/${relativePath}: document ScriptablePack kind ${JSON.stringify(kind)}`,
        );
      }
    }
  }
  const staleTerms = [
    '10 engine-owned kinds',
    '11th kind',
    '12-kind set',
    'summary-only',
    'live handles',
    'shared<AnimationClip> handle',
    'loadByGuid',
    'allocSharedRef',
    'World-owned shared reference',
  ];
  for (const relativePath of [
    ...matrixDocuments,
    'packages/runtime/src/asset-contributions.ts',
    'packages/animation/src/graph/serialize-animation-graph.ts',
  ]) {
    const source = await readFile(resolve(root, relativePath), 'utf8');
    for (const term of staleTerms) {
      if (source.includes(term)) {
        failures.push(
          `engine/${relativePath}: remove stale ScriptablePack fact ${JSON.stringify(term)}`,
        );
      }
    }
  }
  return failures;
}

const failures = await checkDocuments(engineRoot, engineDocuments, 'engine');
failures.push(...(await checkVitePluginPackSurface(engineRoot)));
failures.push(...(await checkMaterialDocuments(engineRoot)));
failures.push(...(await checkAuthorityAuditContract(engineRoot)));
failures.push(...(await checkScriptablePackMatrix(engineRoot)));
failures.push(...(await checkStandardLightingDocuments(engineRoot)));
for (const [relativePath, term] of [
  ['packages/assets-runtime/README.md', 'forgeax:asset-changed'],
  ['packages/vite-plugin-pack/README.md', 'forgeax:asset-changed'],
  ['skills/forgeax-engine-assets/SKILL.md', 'suppressFullReload'],
]) {
  const source = await readFile(resolve(engineRoot, relativePath), 'utf8');
  if (source.includes(term))
    failures.push(`engine/${relativePath}: remove retired public term ${JSON.stringify(term)}`);
}

if (editorRoot !== undefined) {
  try {
    await access(editorRoot);
    failures.push(...(await checkDocuments(editorRoot, editorDocuments, 'editor')));
  } catch {
    failures.push(
      `editor: cannot access ${editorRoot}; pass the checked-out forgeax-editor worktree to --editor-root`,
    );
  }
}

if (failures.length > 0) {
  console.error('catalog documentation exit sweep failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `catalog documentation exit sweep passed (${editorRoot === undefined ? 'engine docs' : 'engine + editor docs'}): AssetEvidence packageUrl notCooked stale unknown; lookup/verify --guid --project --catalog --json`,
  );
}
