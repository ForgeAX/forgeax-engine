# SSR dependency fallback evidence

This directory defines the paired dependency evidence schemas for the reflection
fallback consumer. Generated reports are written under the ignored
`artifacts/ssr-fallback/` directory. It does not claim that SSR v1 is implemented. The parent SSR admission
remains fallback-only until the producer, format, temporal, and identity receipts
are all present and matched.

## Progressive discovery

The first layer answers whether evidence is admissible:

| Field | Meaning |
|:--|:--|
| `status` | `pass` means this lane completed; `blocked` means it cannot be admitted |
| `identity` | source HEAD/tree, lock hash, and built render hash bound to the run |
| `lane` | `browser` or `dawn`; the lanes are paired and cannot substitute for one another |
| `expectations[].verdict` | per-expectation result, with `observed` and bounded `confidence` |

The second layer is the producer evidence embedded in the fixture report: source
selection (`local-probe`, `skylight`, or `neutral`), generation and lifecycle facts,
candidate invisibility, submit-failure handling, device recovery, c=0/c=1, and the
complete r32float profile. These are observations, not a second owner or ledger.

The bottom layer is directly retrievable evidence:

| Lane | Manifest | Detached input | Readback | Validation log |
|:--|:--|:--|:--|:--|
| Browser | `artifacts/ssr-fallback/browser/manifest.json` | `artifacts/ssr-fallback/browser/ssr-dependencies-input.json` | `.forgeax-debug/<runId>/live.png` | `artifacts/ssr-fallback/browser/validation.log` |
| Dawn | `artifacts/ssr-fallback/dawn/manifest.json` | `artifacts/ssr-fallback/dawn/ssr-dependencies-input.json` | `artifacts/ssr-fallback/dawn/frame.png` | `artifacts/ssr-fallback/dawn/validation.log` |

The schemas are lane-specific but intentionally require the same identity,
fixture revision, 300-frame execution, readback, PNG, thresholds, and expectation
shape:

- `browser/manifest.schema.json`
- `dawn/manifest.schema.json`

The execution thresholds are frozen before reading pixels: linear HDR absolute
error `<= 0.05` and HDR luma relative error `<= 0.02`. Pixel readback is supporting
evidence; structured producer and receipt facts remain the admission source.

## Visual reading record

After collecting each PNG, record one row per expectation without inferring facts
from a filename, array position, or page liveness:

```json
{
  "id": "candidate-invisibility",
  "observed": "candidateVisible=false before completion",
  "verdict": "pass",
  "confidence": 0.8
}
```

If a locator cannot be read, use `blocked` and retain the exact path and reason.
Do not replace a missing Browser or Dawn run with a screenshot from the other lane.
The three falsification variants live in `apps/learn-render/6.pbr/4.render-target-reflection/scripts/falsification.mjs`;
they are dev-only failures and must never be copied into a passing manifest.

## Public recovery boundary

The public render route is `inspect -> report locator -> closed error -> owner
recovery -> matching submit -> reinspect`. A report is one joint dependency
projection; it is not a second owner or ledger. Consumers receive detached facts,
never live texture, buffer, encoder, graph, or device handles. Missing or mismatched
receipts keep the parent SSR consumer at `fallback-only` with zero SSR work.

This evidence package does not implement SSR v1, Hi-Z, ray marching, temporal
resolve, composition, or history. `structural-only`, page liveness, a single lane,
RhiNull output, or a screenshot cannot replace paired Browser and Dawn evidence.
