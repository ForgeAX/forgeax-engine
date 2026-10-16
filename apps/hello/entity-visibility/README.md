# Entity visibility

This focused demo shows the render-owned `Visibility` component and its hierarchy
resolution contract. `inherited` follows a valid `ChildOf` parent, while explicit
`hidden` and `visible` intent override that parent result. The renderer reports
explicitly hidden candidates separately from frustum culling.

Run the deterministic checks from the repository root:

```sh
pnpm --filter @forgeax/hello-entity-visibility typecheck
pnpm --filter @forgeax/hello-entity-visibility build
pnpm --filter @forgeax/hello-entity-visibility smoke
pnpm --filter @forgeax/hello-entity-visibility smoke:browser
```

`game-default` composes the same public component on its scored target with a
smaller `B` toggle. That slice intentionally keeps physics, picking, scoring,
and `Disabled` lifecycle independent from render visibility.
