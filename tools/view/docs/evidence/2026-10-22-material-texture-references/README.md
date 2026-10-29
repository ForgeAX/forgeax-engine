# Material texture references evidence

Branch: `codex/material-texture-reference-cards`, originally based on the shared
Mesh card implementation at `275c9e3`. After PR #225 merged, PR #226 was rebased
onto View main `83665a9`, dropping its duplicate prerequisite commit and retaining
main's browser-test repairs. The [check repair report](check-repair.md) records
the original failures and the new verification boundary.

## Local checks

- `pnpm check:packages`: passed.
- `pnpm check:architecture`: passed, 0 architecture violations and 53 tests.
- `pnpm test`: passed, 623 tests after rebasing onto current main, including seven dependency/lifetime tests.
- `pnpm build`: passed. Existing bundle-size and Dockview charset warnings remain.
- `pnpm build:storybook`: passed. No shared component API or story changes.
- `node scripts/verify-material-texture-references-ui.mjs`: passed.

The browser fixture uses explicitly generated test PNGs, not Engine output.
It verifies exact group order, unique dependencies, name/single-click inactivity,
one open per double-click, Enter, ExternalLink, folder navigation, failed/unsupported and
progressively ready thumbnails, layout stability, missing publication, unresolved
dependencies, no-binding inspection, late inspection/thumbnail responses, hidden
panel subscription release and 65-reference batching. Light/dark screenshots at
280px and 360px are separate fixture evidence.

## Native Engine check

The native script copies the existing Game 3D assets into a disposable temporary
project and loads the newly built View candidate. It requests real Engine PNGs
and checks the target GUIDs reached from each of the ground material's three
texture cards. It does not start Play or change the original Engine/project.

Native execution passed on the installed Engine at
`284f102afad1c3d33527064ecc0b84b11262e2e9`. The three real PNGs passed
nonblank pixel checks (luminance ranges 135.33, 223 and 247). Double-clicking each
card admitted the corresponding Texture viewer GUID and target generation:

| Asset | GUID | Target generation |
| --- | --- | --- |
| brick-floor-base-color | fd9145db-6bc8-57c0-a15a-391508daf751 | 2 |
| brick-floor-normal | e257e162-d746-5671-b6d1-3fe838300d43 | 3 |
| brick-floor-roughness | 5690bdef-858f-57d1-82ae-78f6802e630f | 4 |

[Native result](result.json) records the exact Engine package, input source,
material identity and admitted targets. No uncaught page errors were captured.
Server logs separately emitted Scene material program-selection and
`material-skin-attr-missing` diagnostics. These remain Engine-owned and were not
patched; this delivery does not claim a clean general Game 3D Scene render.

[Material cards](native-material-texture-cards.png) show the three actual PNGs
beside the rendered brick material. [Normal viewer](native-texture-viewer-1.png)
shows the real Texture viewer reached through the card. These are screenshots of
the new candidate build in ordinary Chromium, separate from native Codex evidence.

## Native Codex handoff

The installed Codex View frontend was rebuilt from this branch, then reopened
against the existing Game 3D project through the public View opening tool. The
material page was selected and its properties panel revealed through the public
workspace operations. The native DOM showed Texture references and all three
brick-floor asset names; each Engine PNG completed loading at 128 x 128 pixels.
Material facts was collapsed so the cards remained visible for manual acceptance.
No Play was started. The original installed frontend artifact was backed up
locally; plugin configuration and project binding were retained.

Native automation cannot screenshot this nested-frame presentation. DOM and
image-loading checks qualify this handoff, not native canvas pixel acceptance.

## Pairing for submission

View CI selects Engine `635e6bce68445fc4a22c9fa9dbd8a92b5c9fa778`, whose
`tools/view` gitlink is `b40b5501e89b5abb07ec44b79716895bbe65fb6d`. The installed local
runtime remains `284f102afad1c3d33527064ecc0b84b11262e2e9`. The consumed public
publication types, workspace binding/facts and DevKit inspection implementation
are unchanged between these revisions. Local browser results qualify the
installed revision; remote CI qualifies the selected candidate separately.
Engine and View CI configuration remain unchanged.

Fixture screenshots: [light 280px](light-280.png), [light 360px](light-360.png),
[dark 280px](dark-280.png), [dark 360px](dark-360.png). Fixture and native images
remain separate evidence. Captured Engine PNGs: [base color](brick-floor-base-color.png),
[normal](brick-floor-normal.png), [roughness](brick-floor-roughness.png).
