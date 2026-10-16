# Known limitations and trial history

| Area | Current status |
|:--|:--|
| Visual fidelity | Whole-palace 85% resemblance is not established. Secondary geometry, vegetation, carved ornament and materials remain approximate. |
| Focus | Bounds framing works for whole architectural subjects, but foreground buildings can occlude the target. Explicit camera control is available. |
| TAA | Early pixels converge over time; submitted frames and valid history do not mean visually settled output. A TAA/no-AA/TAA control attributed the observed startup drift to temporal accumulation. |
| Delivery | Project tests and the canonical build pass. Browser smoke retains startup/import failures and checks keyboard/mouse plus 300 further frames. Exact packaged-byte validation and the full Engine gate remain separate acceptance steps. |

This workspace uses `@forgeax/engine` through `workspace:*`. The former external project's SDK 0.1.27 type-resolution mismatch does not define the workspace setup.
