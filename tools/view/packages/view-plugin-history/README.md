# Operation history

Optional native frontend plugin `forgeax.view.page.history.frontend` reads
Engine's durable command receipts for the accepted project. It owns timeline
presentation, pagination, details and one selected saved PNG. The Engine
command client records operations and retains artifacts while View is absent.

The UI uses `view.workspace.history.list`, `.get` and `.artifact.read`; the
workspace adapter supplies the accepted project root and delegates to public
`engine.history.*` owners. The frontend imports owner DTOs through `import type`.
It owns no execution, filesystem registry, World or replay endpoint.

The latest page refreshes every two seconds while visible. Older pages stay
stable; hiding, project replacement and plugin disposal cancel outstanding
reads. Incoming records never change the active View page. An unfinished
receipt indicates absence of a completion record, not process liveness.
