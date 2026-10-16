# Starting View

Install the package and its project command Entry:

```bash
pnpm add @forgeax/view
forgeax project plugin install --id forgeax.view --module @forgeax/view/commands --realm build --command-contract @forgeax/view/commands
```

Start the explicit View owner:

```bash
forgeax view start --root /path/to/game
```

Inspect or stop the resident owner:

```bash
forgeax view status --root /path/to/game
forgeax view stop --root /path/to/game
```

`view status` / `view stop` report and end the owner **process**; the live
workspace `view.status` Tool operation (display broker handshake) is a separate
surface that requires a running workspace.

Optional flags: `--headless`, `--software`, `--json`.

- CLI discovery imports only `@forgeax/view/commands`; the owner executor is loaded on invocation.
- The command starts a detached resident and returns its process and target status.
- The owner creates the browser it uses. Set `FORGEAX_CHROME_CHANNEL=chrome` when using an installed Chrome instead of Playwright's bundled Chromium.

### Local checkout / worktree

Install the checkout into the test project when developing locally:

```bash
pnpm add /path/to/forgeax-view
forgeax project plugin install --id forgeax.view --module @forgeax/view/commands --realm build --command-contract @forgeax/view/commands
forgeax view start --root /path/to/game
```

Or start View directly in its checkout while developing the owner itself:

```bash
node src/start-cli.mjs
```
