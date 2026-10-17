# Independent View project sessions

> [!IMPORTANT]
> Engine owns each project runtime and target. View owns presentation intent and
> connection-local page state. A second document must never replace the first
> document's accepted target browser.

| Boundary | Authority |
|:--|:--|
| Host admission | Trusted transport caller, never a supplied connection ID |
| Project/runtime/target/Play | One ordinary Engine workspace runtime per independent frontend session |
| Fresh View entry | Confirmed project intent; explicit project open obtains its own target |
| Headed reload | Same session/target, retired browser resources, new browser generation |
| Tabs, entity/target selection, resource opens | Exact View connection's Broker |
| Display run binding and events | Exact frontend connection, independent run owner retained |
| Pack navigation | Directed intent plus visible DOM receipt; project/source revision rechecked at ACK |

```mermaid
sequenceDiagram
  participant A as View document A
  participant H as Engine Host
  participant B as View document B
  A->>H: admitted project.open
  H-->>A: session A / target A
  B->>H: admitted project.open
  H-->>B: session B / target B
  A->>H: reload target A
  H-->>A: browser generation A + 1
  Note over B,H: target B and page state retained
```

The CLI workspace remains an independent owner. A page-less operation that
changes presentation is ambiguous when multiple pages exist. A Pack reveal with
an explicit live connection can target that page; no connection means a unique
page is required. Disconnect retires only that page's projection and pending
receipts, never another project or an independent run.
The public workspace API now owns `pages.list` and `pack.reveal`, with CLI
contributions derived from those same operation names. MCP clients may project
their bounded results but must not read Broker page storage or invoke reveal
through a private adapter path. The visible receipt and stale-page behavior
remain owned by the View frontend connection.

The Host resolver is an assembly capability over ordinary Engine runtimes,
not a Scene/Play mode in App or World. Existing target-specific transport
admission, command routing and reload retirement remain authoritative.

The bounded summary takes a running project target's generation from its exact
live root preview. Another preview or browser generation cannot supply it;
before that owner exists the generation remains absent.

Acceptance requires real simultaneous headed pages, independent Engine targets,
page selections and resource opens, Display events, refresh, directed Pack
receipts and rejection of old-page acknowledgments. Unit tests alone do not
establish browser acceptance.

## Paired acceptance

The headed matrix passed with two independent Engine targets, real Scene and Mesh opens, actual workspace and Display events, distinct run bindings, directed visible Pack reveal and refresh retirement. The View CI baseline is Engine `42d2859a4e14aa09efe34aa3b204f19638bf4d9b`, which supplies the caller-scoped runtime resolver. The preceding CI run against old Engine `b07cc7e` failed two isolation assertions because that Engine still shared its project runtime. Keep those assertions and qualify all four paired browser shards against the new baseline.

CI derives pnpm from the paired Engine `packageManager` instead of maintaining a second version. The new-baseline run originally failed action setup because the workflow still named pnpm 11.7.0 while Engine required 12.10.1; no architecture tests ran in that job.

The paired checkout uses Engine at the workspace root and View at `tools/view`, matching Engine's native composite-action paths. Both build and browser jobs call the existing source-keyed Rapier preparation action before package build. A cold new-baseline build without that owner failed `rustc unavailable`; its browser jobs were skipped, not accepted.
