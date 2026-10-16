# @forgeax/engine-intelligence-dsh

Host-side adapter from the provider-neutral ForgeaX `Activity` contract to the
DeepSeek Harness TypeScript SDK. The package exact-pins SDK `0.1.0-rc.6`; no DSH
type crosses into `@forgeax/engine-intelligence` or an Engine Worker.

```ts
const provider = createDshIntelligenceProvider({
  launch: {
    command: '/path/to/dsh-jsonrpc-agent',
    args: ['/path/to/cordis.yml'],
    env: process.env,
  },
  cwd: gameProject,
});
const intelligence = createIntelligenceRuntime(provider);
```

The executable must be a DSH SDK JSON-RPC runtime whose Cordis configuration
includes `@deepseek-ai/dsh-sdk-jsonrpc-server`. The ordinary `dsh` TUI/headless
launcher is not that protocol endpoint.

DSH 0.1 has no wire-level prompt cancellation. This adapter therefore gives
each Activity an independent runtime process: cancelling closes and reaps only
that process. Conversation continuity remains a persisted provider-scoped
`SessionRef`, so a later Activity may resume the same DSH session from a fresh
runtime. Completion, failure, cancellation, and provider disposal all await the
SDK close ladder; the Engine frame loop only polls already-buffered POD events.
