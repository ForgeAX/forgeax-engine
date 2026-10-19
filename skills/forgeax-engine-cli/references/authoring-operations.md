# Authoring operations

> [!IMPORTANT]
> Project operations behind the single forgeax product entry. For RHI capture, replay, and per-draw inspection, use [`forgeax-engine-rhi-debug`](../../forgeax-engine-rhi-debug/SKILL.md).

## Start with discovery

```bash
forgeax help --tree --json
forgeax help project build --json
forgeax project build --input request.json --json
```

list projects the Tool Catalog from forge.json and package.json without executing game modules. describe returns stable id, execution realm, argsSchema, resultSchema, and required evidence. Build requests from that descriptor rather than guessing inputs from operation names.

Command envelopes and ToolTerminal are separate result layers:

```ts
const envelope = JSON.parse(stdout);
if (!envelope.ok) recoverCommand(envelope.error);
else if (envelope.value.outcome === 'failed') recoverTool(envelope.value.failure);
else consume(envelope.value.result, envelope.value.artifacts);
```

Branch on failure.code, then read expected, hint, and narrowed detail. Project files, Meta/Pack/WGSL, and import source own authored truth; catalogs, caches, preview carriers, and run evidence are rebuildable projections.

## Plugins and operations

Plugin definitions and configuration belong to Pack; `forge.json.roots` selects root assets.
Use `.pack.ts` for same-file named Plugin exports, or pass `--module` for an existing implementation
(required with `.pack.json`). `--input` accepts the complete request, including JSON configuration;
`--dry-run` returns the generated `source`. Read the request schema first:

```bash
forgeax help asset plugin create --json
forgeax asset plugin create --path assets/movement/movement.pack.ts --json
forgeax help project root set --json
forgeax asset plugin inspect --json
forgeax help asset source import --json
forgeax help asset source clone --json
forgeax help project migrate --json
```

Source transfer includes Pack, modules, resources, and dependency-lock evidence. Import preserves identity;
clone creates new identities and rewrites known references. Destinations must be beneath assets.
Repair source diagnostics before retrying a failed candidate. Reading definitions does not install them;
only active native providers are callable. Source or configuration changes rebuild the session.

defineTool(descriptor, executor) colocates static metadata and execution. Executors return JSON-safe results, SnapshotRef, and ArtifactRef; live World, Renderer, Canvas, Context, Fiber, or session handles cannot cross the boundary. Use context.emit for progress, context.runChild for child work, and register fallible cleanup with context.addCleanup before starting. Expected failures return structured { ok: false, error }.

The SDK command client and createBrowserCapture are composable APIs. For continuous observation, use the live instance owned by forgeax dev; scripts handle
Playwright interaction and checkpoint compositor screenshots. This is not a Catalog operation: Page and
session remain program-local, and programs return only JSON-safe capture rows/report paths. On exit,
DevKit closes sessions. One-shot forgeax project capture --backend software reuses the browser owner.

## Composition and evidence

Compose ordinary TypeScript without a workflow DSL, second registry, or hidden current snapshot:

```ts
export default async function run(operations) {
  const authored = await operations.run('author.write-value', input);
  if (authored.outcome === 'failed') return authored;
  return operations.run('project.build', buildArgs, {
    snapshot: authored.snapshotAfter,
    deadlineMs: 30_000,
  });
}
```

```bash
a Node or Bun script using the SDK command client program.mjs --json-stream
```

Describe preview before forming a recipe. Public operations material.preview, mesh.preview, vfx.preview, and texture.preview use GUIDs through the Engine-owned AssetRegistry. Hidden presentation still creates a real Canvas/WebGPU Renderer, advances World, submits draws, and returns verifiable artifacts; RhiNull or screenshot mocks cannot substitute.

Optional services accelerate the same operation only with explicit DevKit benchmark admission; missing/invalid admission selects the private executor. Services transport serialized inputs and snapshot/artifact refs without owning operations or live Engine state. Preserve failure terminals on disconnect, then explicitly retry the private path from project authority.

## Source authorities

| Contract | Source |
|:--|:--|
| Tool types, terminal, runtime error | `packages/tool-runtime/src/` |
| CLI, Catalog, built-in contribution | `packages/devkit/src/tools/` |
| Plugin asset authoring | `packages/devkit/src/plugin-authoring.ts` |
| Native asset mount and startup | `packages/plugin/src/asset.ts` / `startup.ts` |
| Preview recipe/evidence | `packages/app/src/tool-preview/` |
| Service admission | `packages/devkit/src/tools/benchmark/` |

Run owner package tests after changes. Preview/visual paths also require applicable Browser/Dawn gates; unit-only checks cannot prove GPU execution.
