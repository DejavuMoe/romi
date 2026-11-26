# Prototype-first UI

[中文](README.zh-CN.md)

A project-local design capability system for general-purpose AI agents. Create
shared foundations and components, then use them for UI, websites, presentations,
documents, diagrams, brand visuals and data dashboards. The original invocation
name is retained. Version 3 runs independently of Baoyu-Design.

One skill entrypoint routes to focused references; only the current task's
capabilities are loaded. No bundled editor, proprietary artifact runtime, global
configuration, or mandatory external design skill. Existing project formats,
components and tooling remain the source of truth.

## Capabilities

| Mode | Deliverable |
|---|---|
| `system` | Brand foundations, semantic tokens, real component previews, composition and usage rules |
| `prototype` / `explore` | Pages, apps, wireframes and working interaction flows |
| `compose` | Slides, designed documents, posters, social assets, diagrams and brand imagery |
| `visualize` | Charts and dashboards with traceable data and metric checks |
| `verify` / `sync` | Rendered review, export checks and controlled updates |

Product UI retains the audit/approval/implementation gate. Standalone artifacts
use medium-specific checks without invented production mappings or UI commits.

## Requirements

- A file-capable AI agent; shell access for executable checks.
- Python 3.9+ for bundled standard-library validators; Git for UI commit gates.
- A browser, native runtime or format renderer for visual verification.
- Optional: image generation, native exporters and project-specific libraries.
  Node.js is only needed for the DOM collector's syntax check or a chosen runtime.

## Installation

Run from the target project directory; select **project scope** and your agent:

```sh
npx skills add DejavuMoe/prototype-first-ui --skill prototype-first-ui --copy
```

Alternatively, extract the skill from
[GitHub Releases](https://github.com/DejavuMoe/prototype-first-ui/releases)
into `<project>/.agents/skills/prototype-first-ui/` (or the host's project-local
equivalent). Do not use a global install or a home-directory skills path.
The optional installer needs Node.js; manual extraction does not.

This repository is the distributable source, not a product workspace; no nested
copy or global installation is needed to develop it. Hosts without skill
discovery can read the installed `SKILL.md` directly.

## Usage

```text
$prototype-first-ui system
Extract this project's typography, semantic colors and reusable components into
a design system. Use real components in the preview and document how a new page,
slide deck and chart should consume it.

$prototype-first-ui compose
Create an editable six-slide product introduction using our project design system
and approved copy. Inspect the rendered slides and report export limitations.
```

```text
$prototype-first-ui prototype

Design a bulk rename flow for this file manager. Include a preview of the changes,
filename conflicts, and cancellation. Present the prototype for review.
```

After review:

```text
$prototype-first-ui implement

Implement the approved designs/file-manager/index.html from design commit <SHA>.
Limit the change to the bulk rename flow.
```

Agents without named skill invocation can read the installed `SKILL.md` directly.
More examples: [English](references/prompts.en.md) · [中文](references/prompts.zh-CN.md).

## Workflow

For product UI: audit → prototype → review → approve → implement → verify.

| Mode | Purpose |
|---|---|
| `audit` | Record current product capabilities, interfaces, and states |
| `explore` | Compare alternative design directions |
| `prototype` | Create or revise an interactive prototype |
| `approve` | Record approval of a specific prototype version |
| `implement` | Implement an approved feature |
| `sync` | Reconcile prototype and production differences |
| `verify` | Check content, visuals, interactions, and accessibility |
| `bootstrap` | Optional repository cleanup and local history reset with a recovery snapshot |

[Skill instructions](SKILL.md) · [Workflow reference](references/workflow.md) ·
[Release guide](RELEASING.md) · [Changelog](CHANGELOG.md)

## Upgrade from 2.x

Approval now uses project-owned `design-review.json`, not `_d_meta.json`.
The gate also checks every declared prototype dependency, including binary assets.
Follow [the migration guide](references/design-review.md); an old status flag is
not automatically converted into approval. Existing UI/content/source contracts
remain usable. No upstream skill needs to be installed.

The upstream review and capability choices are recorded in
[design lineage](references/design-lineage.md). This implementation does not vendor
upstream prompts, editors, fonts or runtime formats.

## License

[MIT](LICENSE)
