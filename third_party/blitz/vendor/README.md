# Maintained Stylo source

`stylo/` is the crates.io `stylo` 0.22.0 source archive, including its original
MPL-2.0 notices and `.cargo_vcs_info.json` upstream revision. Cargo dependencies
remain pinned by the consuming lockfile. The only source changes add the standard
`prefers-reduced-motion` media feature to Servo's evaluator and expose its device
preference to embedders; Gecko already implements this feature. A Servo animation
fix marks canceled animations dirty so recascading removes their sampled values
immediately when `animation-name` changes (including reduced-motion rules).

Blitz's workspace uses this one source for every `style` consumer. Its ordinary
Git history records the maintenance patch. The UI adapter regression exercises
the unchanged author query, live preference changes, keyframes and transitions.
