# Validation and Feedback

This project consumes the procedural and UE texture-input cloud libraries from
`forgeax-engine-assets/demo-assets/volumetric-clouds`. Their source assets and
license files remain with those libraries. The app's authoring archive excludes
their payloads; the web archive includes their required cooked runtime output.

| Check | Reproduction |
| :-- | :-- |
| App contracts and shared-library ownership | `pnpm test` |
| Public API compatibility | `pnpm typecheck` |
| Actual scene, UI and renderer health | `forgeax dev verify --require-ui` |
| Both materials in the static release | `forgeax project play scripts/playthrough-shared-assets.mjs --release --backend hardware --require-ui` |

For a rendering issue, retain the Engine revision, library revision, material
mode, completed frame identity, structured renderer error and a screenshot.
`7cae6725aa` needs the cloud-shadow producer admission correction before this
demo's first-frame render can be accepted. Do not disable shadows to conceal a
resource dependency error.
