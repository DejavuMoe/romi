# Usage examples

## Shared system

```text
$prototype-first-ui system
Build this project's design system from the existing brand and components. Include
semantic tokens, supported component states, a preview and consumption guidance.
Keep it in this project; do not install or configure global skills.
```

## Visual communication

```text
$prototype-first-ui compose
Use the project system and supplied copy for a six-slide introduction and a one-page
handout. Keep source editable, inspect both formats, and disclose unavailable exports.
```

## Data visualization

```text
$prototype-first-ui visualize
Turn this CSV into a dashboard using the project system. Define the metrics and
date semantics, verify totals and filters, and preserve source traceability.
```

## Audit

```text
$prototype-first-ui audit
Record this product's current screens, actions, states, and interfaces in docs/ui/capabilities.md.
```

## Explore

```text
$prototype-first-ui explore
Explore three navigation and workspace layouts for <product>, using the existing capabilities and design system.
```

## Prototype

```text
$prototype-first-ui prototype
Prototype <feature> in designs/<project>/. Include the normal flow, empty state, errors, and cancellation, then present it for review.
```

## Approve

```text
$prototype-first-ui approve
I approve the current designs/<project>/index.html. Record its approval and create the design-only commit.
```

## Implement

```text
$prototype-first-ui implement
Implement <feature> from the approved designs/<project>/index.html at design commit <SHA>.
```

## Sync

```text
$prototype-first-ui sync
Compare the production <surface> with its approved prototype and fix implementation drift.
```

## Verify

```text
$prototype-first-ui verify
Check <feature> against its approved prototype, including interactions, content, responsive layout, and keyboard accessibility.
```

## Bootstrap

```text
$prototype-first-ui bootstrap
Clean this repository and replace its local Git history on branch <branch> after creating and verifying an external recovery snapshot. Preserve the application and leave the remote unchanged.
```
