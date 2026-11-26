# Design lineage and independence

Reviewed on 2026-10-31 using the user's browser, against
[Baoyu-Design commit 5a1a6f2](https://github.com/JimLiu/baoyu-design/tree/5a1a6f2ca2606108fc08050a78c4731adc6a2351),
release 2.4.1. The [changelog](https://github.com/JimLiu/baoyu-design/blob/5a1a6f2ca2606108fc08050a78c4731adc6a2351/CHANGELOG.md)
records that 2.3.0 archived the original skill. Current capabilities are organized
around design canvases, design systems, slides, dashboards and data visualization.

| Observed capability | Independent project-local treatment |
|---|---|
| Shared system consumed by multiple artifact types | Canonical project tokens/components with medium-specific composition |
| Editable canvases and decks | Existing project/native formats or ordinary HTML/CSS/SVG; no required canvas runtime |
| Component-library extraction | Real component previews and explicit source/coverage, not look-alike redraws |
| Data-backed dashboards | Traceable datasets, metric definitions and calculations with checks |
| Editor comments and revision | Existing chat/review tools with stable artifact identifiers and fresh file reads |
| Export | Available format adapters; inspect actual exported files and disclose missing capabilities |

These are capability goals, not copied implementation instructions. New references
are independently authored for this repository. No upstream prompts, starter
components, editors, icon fonts or artifact schemas are vendored. In particular,
upstream's instruction to skip browser verification in some artifact workflows
is not adopted: this skill requires rendered evidence for visual claims.

The upstream [NOTICE](https://github.com/JimLiu/baoyu-design/blob/5a1a6f2ca2606108fc08050a78c4731adc6a2351/NOTICE.md)
distinguishes maintainer-owned MIT work, Anthropic-origin material and third-party
licenses. Do not infer blanket reuse permission from its repository name or root
license. Any future import needs its own provenance and applicable notices.

## Deliberate boundaries

The system covers design decisions, creation, review and handoff across media.
It does not promise identical native export/editor capabilities on every agent.
Hosts supply file access, rendering, optional generation and export. Missing
capabilities produce explicit gaps, not fabricated success.

Keep one distributable skill with task-specific references until independently
invoked capabilities justify separate packages. This avoids duplicate foundations,
cross-skill dependency installation and global configuration. The public name
`prototype-first-ui` is retained for compatibility despite the broader scope.
