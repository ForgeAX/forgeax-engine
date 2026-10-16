# @forgeax/engine-dsh

This package is the concrete ForgeaX ↔ DeepSeek Harness federation connector. It does not merge the two Cordis roots or introduce a second plugin lifecycle.

## Ownership

- `dshRealmPlugin()` runs in an Engine `Context`. It attaches to an explicit compatible endpoint, launches an explicit or PATH-discovered `dsh`, or launches the packaged minimum fallback. Attach owns only a lease; launch owns the child process.
- The package root is an ordinary DSH Host plugin loaded by the native DSH Loader. It registers versioned POD routes and, when no Engine endpoint is supplied, owns a minimum headless `World`.
- `./client` is an ordinary DSH Web client plugin. It contributes a panel through `shell.overlay`; unmounting the Fiber removes the panel, polling, listeners, and iframe.
- `enginePreviewPlugin()` runs in an Engine `Context`. It exposes only versioned `postMessage` POD and never transfers `World`, `Renderer`, `Fiber`, or RHI handles.

## Engine hosting an existing DSH installation

Install this connector into the selected DSH profile explicitly through DSH's package authority, then mount the Engine plugin:

```sh
dsh plugin --profile web add @forgeax/engine-dsh
```

```ts
import { dshRealmPlugin } from '@forgeax/engine-dsh/engine-host';

const app = await createApp(canvas, {
  plugins: [dshRealmPlugin({ profile: 'web' })],
});
```

Runtime mount never edits the profile. Disposal stops only a process launched by this Fiber; attaching to `endpoint` releases only its bridge lease.

## DSH showing an existing Engine

Launch an Engine page that mounts `enginePreviewPlugin()`, then point the DSH Web profile at it:

```sh
FORGEAX_ENGINE_ENDPOINT=http://127.0.0.1:5173 dsh web
```

The DSH panel embeds that endpoint directly. This is the preferred local Web path because it preserves real browser pixels without GPU readback or image encoding. Headless fallback reports tick/control state without pretending to provide pixels.

## AI Native consumer

`createDshRealmIntelligenceProvider(connection)` adapts a ready bridge to the provider-neutral `IntelligenceProvider` contract. The DSH side remains an ordinary native plugin that provides `forgeaxIntelligenceCapability`; Engine sees only bounded Activity input/output and cancellation.

This is the persistent-realm topology. `@forgeax/engine-intelligence-dsh` remains the direct DSH SDK adapter whose isolated runtime process owns each Activity; neither package reimplements the other's transport.

```ts
import { createIntelligenceRuntime } from '@forgeax/engine-intelligence';
import { createDshRealmIntelligenceProvider } from '@forgeax/engine-dsh/intelligence';

const intelligence = createIntelligenceRuntime(
  createDshRealmIntelligenceProvider(app.pluginContext.dshRealm),
);
```

## Gates

The integration and visual gates require a compatible user- or CI-provisioned `dsh` executable on `PATH` (or `DSH_EXECUTABLE`). The Engine workspace does not install or embed the DSH CLI as a package dependency.

```sh
pnpm --filter @forgeax/engine-dsh test
pnpm --filter @forgeax/engine-dsh test:integration
pnpm --filter @forgeax/engine-dsh test:visual
```
