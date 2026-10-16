# @forgeax/engine-project

The realm-neutral schema and injected JSON reader for `forge.json`. Its strict schema is **3.0.0**; `roots` is required and may be empty. Each optional `build`, `host`, `frontend`, or `engine` key names one plugin asset GUID.

```json
{
  "id": "my-game",
  "name": "My Game",
  "schemaVersion": "3.0.0",
  "roots": { "engine": "00000000-0000-4000-8000-000000000001" }
}
```

| Root | Installation owner |
|:--|:--|
| build | Isolated Node build process with producer registries |
| engine | App's World realm, on the main thread or an Engine Worker |
| host | DOM, audio and host transport realm |

Configuration belongs in the referenced Pack asset. Native plugin code composes children. A scene is instantiated and released by a scene-owner plugin. The project manifest remains outside the asset Catalog.

## Read a project

```ts
import { loadGameProject } from '@forgeax/engine/project';
import { readFile } from 'node:fs/promises';
const result = await loadGameProject(path => readFile(`/games/my-game/${path}`, 'utf8'));
if (result.ok) console.log(result.value.name, result.value.roots.engine);
else console.error(result.error.code, result.error.hint);
```

`loadGameProjectSync` accepts the equivalent synchronous reader. `GameProjectSchema` and its inferred `GameProject` type are the field authority. Unknown fields and malformed GUIDs fail before any plugin is installed. Closed errors and their narrowed detail are defined in [errors.ts](src/errors.ts).

## Migration

Legacy project installation trees and implicit default scenes are rejected. DevKit's `project migrate` creates a separately validated candidate project from a schema 2.0 manifest and statically convertible composition. Dynamic configuration, children or update hooks report the owning source location for an explicit rewrite. See [DevKit](../devkit/README.md).

| Root | Execution owner |
|:--|:--|
| `host` | Resident Node backend |
| `frontend` | Browser DOM and UI |
| `engine` | World in the selected execution realm |
| `build` | Isolated import/cooking process |
