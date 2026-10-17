# Late task clocks and incomplete GPU retention, 2026-10-17

## Captured workload and owner

Game `5208e87f` / Engine `a55ea871`, index digest `638daaba...87ce153`, retained
full materials, TAA, 1920x1080 output and the existing ten-actor fireline. The
ordinary, late native-only, late CPU+Task and passive-GPU runs were independent
captures. Matching build/workload permits owner hypotheses, not transplantation
of one run's exact timestamps, GC samples or GPU receipts into another.

The Game cohort report
preserves actual raw/script hashes and the private derivation scripts. Reuse the
[Game producer and analyzer](../toolbox.md#explicit-late-cpu-and-task-capture).
This case adds no Engine Runtime change or ordinary performance verdict.

## Delayed CPU activation and the safe cohort

READY retained its original order. A completed first-LIVE anchor triggered the
requested 9..16-second window; the actual trigger was 10ms late. CPU request/ack
bounds left a requested-prefix hole of 56.6..943.4ms. Each profile's original
endpoints qualified inside its own native CDP command brackets.

| Realm | Header-to-first-sample hole | Reordered interval weight | Inline observer script ID |
| --- | ---: | ---: | ---: |
| Host | 142.537ms | 1391.716ms | 570 |
| Engine Worker | 883.631ms | 895.970ms | 495 |
| Render Worker | 327.706ms | 517.357ms | 43 |

The maximum first-observed timestamp was `2534309966073us`; the first selected
EW task started at `2534309966166us`, 93us later. All 350 source frames
1509..1858 (`world-1`, device 0) therefore had complete endpoint tasks after the
startup holes. Seven exact transport stages and original task indices admitted
this contiguous cohort. Earlier completed receipts remained untraced, not idle.
The inline IDs above are dated observations, never reusable configuration.

Freeze actual loaded JS and chained maps before replacing output. This capture
retained 123 loaded scripts and authenticated both map levels; resolving the
frozen bytes reproduced the collector's symbols. Product, observer, unmapped,
GC and reordered-sensitive weights remain separate.

## One current completed gap

Source1589's Host gap was 51.7ms. Its successive RW completed-send interval was
53.498ms, intersecting 53.245ms of owned native tasks. Within that native interval:

| Observation | Actual duration |
| --- | ---: |
| Successor1590 submitted-containing task | 17.418ms wall / 16.982ms whole thread CPU |
| Successor1591 submitted-containing task | 16.461ms wall / 16.280ms whole thread CPU |
| Incremental-marking scheduled task | 9.921ms wall |
| cppgc sweep scheduled task | 6.059ms wall |
| Stable sampled GC | 11.543ms |
| Sampled observer | 1.396ms |

These are different accounting scopes. Heap-scheduled task wall is not pure GC,
successor envelopes are not function self time, and sample weights are not
additional durations to add to native task totals. The CPU+Task run had no GPU
observer; it does not identify when hardware completed or justify a yield,
capacity increase or CPU-successor retry.

## Passive GPU retention

The separate same-build GPU report
closed successfully while its conservative 64MiB passive receipt budget filled.
It retained 555 exact timed LIVE receipts among 1105 selected completions;
580 copies were partial and 568 frames were dropped across the complete run.
The byte estimate describes copied payload bounds, not heap residency.

Source1106 had a same-capture 72.9ms Host gap and a complete measured GPU envelope
of 10.682368ms. Source1889's later 67.6ms gap had no retained exact observation.
Neither the early envelope, neighboring/latest polls nor the independent CPU
capture fills that missing row. Subtracting measured GPU intervals from Host
gaps does not identify CPU or queue time; overlapping pass totals do not give
whole-frame latency. Retention success, observation completeness and ordinary
FPS acceptance remain separate decisions.
