# `@forgeax/engine-skinning`

> [!IMPORTANT]
> Owner: skeletal binding and joint resolution. This package is renderer-independent and is optional until a world contains a `Skin` component.

```ts
import { Skin, resolveSkinJoints, skinningPlugin } from '@forgeax/engine-skinning';

const plugins = [skinningPlugin()];

const binding = resolveSkinJoints(jointPaths, names, skinEntity);
if (!binding.ok) {
  // binding.error.code is the recovery key; keep the structured detail.
}
void [Skin, plugins];
```

| This package owns | Excluded concepts |
|:--|:--|
| `Skin`, `skinningPlugin`, joint path binding, skinning error union | Renderer lifecycle, animation playback, material or GPU policy |

`SkinError` is a closed union. It also owns the automatic Scene hook's
`SkinAssetUnresolvedError` and `SkinJointPathUnresolvedError`; Render returns
these original classes and Assets preserves them through rollback and Result.
 Use the `code`, `expected`, `hint`, and `detail` fields from [`src/errors.ts`](src/errors.ts) to recover.

Hosts that instantiate skinned scenes add `skinningPlugin()` to their World/App plugin list. The component remains optional and is not registered by renderer assembly. Load `Skin` and `resolveSkinJoints` from `@forgeax/engine-skinning`; no compatibility alias is provided.

Ordinary Scene assets may author `Skin.joints` as explicit entity references.
Scene remaps them per instance, and the post-spawn renderer hook preserves a
nonempty list, including multiple same-name rigs in one Scene. An empty list
uses the existing matching SkinAsset's joint-path resolution. Render extraction
still validates the skeleton, joint count and live propagated joint transforms
before publishing a palette; explicit references do not bypass those checks.
