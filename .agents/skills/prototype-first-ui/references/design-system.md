# Project design system

Use for creating, extracting, extending, or maintaining reusable design decisions.
The result must help another agent produce consistent work without this chat.

## Establish the source of truth

Inspect existing styles/tokens, component exports, representative screens, assets,
brand guidance and platform constraints. Distinguish what the product currently
does from what the user wants it to become. Keep an established token format and
component API; do not translate them into a second format just for this skill.

If no system exists, start under `designs/system/` with only:

- `foundations.md`: intent, typography, color roles, layout/density, image/icon
  direction, motion, accessibility, and where canonical sources live;
- `tokens.css` for browser-first work, or the platform's native token format;
- `components.html` or the project's component preview route, demonstrating the
  reusable components this task actually needs;
- `design-review.json` when tracking review; source register when using references.

Read [the foundations template](../assets/foundations.template.md) as a checklist,
not mandatory prose. A token file and static swatches alone are not a complete
system: include composition rules, interaction states, and consumption instructions.

## Build a coherent language

1. Define the desired reading order and task emphasis. Choose a small type scale,
   line lengths, spacing rhythm, density, container/grid rules, and responsive
   behavior. Derive choices from content and viewing distance, not a fixed trend.
2. Separate primitive values from semantic roles: canvas, surface, primary and
   secondary text, border, focus, action, selection, and meaningful states. Bind
   components to roles so theme changes do not require scattered literal edits.
3. Add theme values only for supported themes. Document fallback fonts, missing
   assets, long-label behavior and localization. Do not silently replace a brand
   font or add dark mode outside scope.
4. Specify component anatomy, variants, content limits, interaction semantics,
   keyboard/focus behavior, loading/disabled/error states, and usage boundaries.
   Point to actual production exports when they exist. Run real components in
   the project's preview environment instead of painting similar-looking copies.
5. Show how components compose into the requested screen, chart, slide, or print
   page. Share identity and semantic meaning across media; adapt density, type
   size, units and interactions to each medium rather than scaling a web page.

For extraction from an existing library, map documented props and exports and
test representative supported states. Do not claim full library coverage after
inspecting only a few examples. Label a visual approximation when the runtime
cannot load the real component, with the reason and missing verification.

## Verify and maintain

Check token references resolve, examples consume the canonical values, supported
themes preserve contrast, focus is visible, and meaningful states do not rely
on color alone. Measure contrast with available tooling against the actual
background; report measurement coverage instead of declaring accessibility from
appearance. Exercise interactive examples with keyboard and pointer/touch.

Before changing shared foundations, find consumers and identify which outputs
change. Record the source path and revision in each deliverable's handoff. Use
direct references inside the project; for a portable export, snapshot only the
needed assets and record their source revision. Never auto-refresh an approved
deliverable to newer tokens: inspect the resulting diff and return changed UX to
review. Commit design-system changes separately from production adoption when
the UI gate applies.

Deliver the preview plus a short consumption recipe: which token/component files
to use, which variants are supported, how to preview/check, and known gaps. Keep
these facts in foundations/usage notes, not duplicated throughout every artifact.
