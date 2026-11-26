# Data visualization and dashboards

Use for analytical pages, charts in any medium and data-driven graphics. Read
[UI design](ui-design.md) only for interactive product surfaces, or
[visual communication](visual-communication.md) for a deck/report using charts.

## Establish what the data means

Read the supplied dataset or authorized source. Record provenance, observation
period, refresh time, units, timezone, field definitions and missing values.
Identify aggregation grain, filters and comparison baselines before computing a
metric. A screenshot of a number does not establish a reproducible dataset.

Keep data and presentation separate. Compute totals, rates and changes from
source rows; record formulas and denominators. Check a small known example or
independently recompute a result, including empty data, zero denominator and
missing/duplicate observations. Do not interpret missing as zero without a
domain rule. Parse dates explicitly and keep calendar dates separate from instants.

When real data is unavailable, label fixtures as illustrative and do not claim
business conclusions. Include only fields needed for the task; keep private raw
data out of exported client assets. Do not attach a raw dataset just for traceability
when a safe aggregate and source reference suffice.

## Choose the representation

| Question | Useful starting point |
|---|---|
| Compare category values | Sorted bar or dot plot |
| Understand change over time | Line plot with explicit missing intervals |
| Inspect distribution | Histogram, box plot or individual observations |
| Understand relationship | Scatter plot with units and context |
| Show composition | Stacked bars or a small, clearly labelled part-to-whole view |
| Retrieve precise values | Table, possibly with a compact supporting chart |

These are choices, not a chart quota. Avoid adding a chart when a sentence or
table answers the question better. Explain unusual axes, transformed values,
truncation and uncertainty. Bars normally start at zero; split incompatible
scales rather than implying correlation with independent axes.

Use project semantic text/surface tokens and consistent series identities.
Categorical color identifies entities; sequential intensity shows magnitude;
diverging encoding needs a meaningful center; status has separate semantics.
Do not rely solely on color: labels, symbols, patterns or accessible tables must
carry the distinction. Evaluate actual contrast and available color-vision checks;
do not claim a palette is validated by naming a familiar color scheme.

## Interaction, refresh and verification

Interactive charts need usable hit areas, keyboard/touch alternatives, bounded
tooltips and readable values without hover. Filters must update charts, metrics
and tables consistently. Include loading, empty, error and stale-data behavior;
never show obsolete numbers as current after a refresh fails. Display dates and
numbers in the intended locale without changing computation precision.

Inspect label collisions, legends, axes and overflow at relevant sizes. Verify a
filter against expected rows and a metric against its calculation. For static
exports replace hover-only information with labels, notes or tables. Re-render
after data changes; source freshness does not guarantee an old export is current.

Deliver the editable view, safe source references, metric definitions and actual
checks. Do not add a scheduler, database, connector, chart framework or live-feed
claim unless the task needs one and the environment supports it.
