# Mesh Material Slots Acceptance

Date: 2026-10-22. Design: [Mesh material slot cards](../../2026-10-22-mesh-material-slots-design.md).

## Verification

| Check | Result |
| --- | --- |
| Package types and component types | Passed |
| Architecture | Passed; 53 regressions |
| Unit suite | Passed; 613 tests, none skipped, after rebasing onto current main `e487d9b` |
| Product and Storybook builds | Passed |
| Mesh UI regression | Passed; light/dark, 220/280/360/640px, long names, thumbnail gestures, ExternalLink, browse, collapsed details, duplicates, builtin/missing references, failed images, hide/show, wireframe and stale queries |
| Scene thumbnail UI regression | Passed |
| Native Engine regression | Passed against installed Engine `284f102`; real references, PNG decoding, nonblank capture and Material-page navigation |
| `git diff --check` | Passed |
| Harness local installation check | Unavailable: no machine-local install manifest |

Package types, architecture, all 613 tests and the Mesh UI regression were
rechecked after rebasing onto current main. Local pnpm disables dependency
verification because the worktree reuses
the installed dependency store. Socket/browser checks require host permissions.
This report does not claim all four Engine browser CI shards ran locally.
CI retains main's Engine pin `635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778` unchanged.

## Artifacts

- `native-references.json`: exact bound preview, revisioned tree and native
  inspection; authored slots share the returned material GUID and the third is builtin.
- `result.json`: exact Mesh and Material identities, no browser page errors,
  and captured pixel contrast 61.3333.
- `native-mesh-capture.png`: actual Engine PNG.
- `native-mesh-cards.png` and `native-material-navigation.png`: native browser evidence.
- `light-360.png` and `dark-280.png`: fixture layout evidence after the header/order adjustment.

The UI check asserts Mesh facts / Material slots / Submeshes / Collision order,
equal title height/background/padding/border width, the section icon and a distinct
stripe color. Native evidence verifies reference and navigation ownership;
the fixture screenshots qualify the later section-header presentation.

The subsequent [PR 225 check repair](check-repair.md) records the stale runtime
slot assertion and missing Game 3D input-admission preconditions exposed by CI.

Native acceptance exposed an unstarted resource action reader. Its native Fiber
now owns the subscription and cleanup; `resource-asset-actions.test.mjs` covers
stale target callbacks, removal and restoration. No Scene selection, Play or
independent run is changed. No Engine source modification was required.
