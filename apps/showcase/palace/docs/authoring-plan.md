# Palace authoring plan

## Capability choice

| Need | Use / entry | Proof | Defer |
|:--|:--|:--|:--|
| Code architecture assets | Pack source + geometry + keyed SceneAsset | asset verify, runtime GUID loads | Manual editor |
| Daylight and materials | Standard materials, directional shadows, environment | Actual GPU capture | Custom renderer |
| Continuous inspection | CLI dev and code API | Same owner, revisions, captures | Second service |

## Template Disposition

- Runtime/controller code: REPLACE; architectural inspection starts with a static authored camera.
- Player character and animation: REMOVE; no unrelated mannequin in the reference view.
- Scene entities and composition: REPLACE; Palace Museum reference geometry.
- Meshes and materials: REPLACE; reusable architectural construction functions.
- Lighting and environment: ADAPT analytic daylight code; new package identity and sun orientation.
- UI and copy: REPLACE; clean reference view initially.
- Template tests: REWRITE for geometry, identity and architectural constraints.
- Residual template identifiers allowed at delivery: none in authored active content.

The maintained showcase contains only its authored scene and geometry; historical starter backups remain outside this app.
