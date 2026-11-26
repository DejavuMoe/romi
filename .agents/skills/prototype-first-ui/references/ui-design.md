# Pages and interaction prototypes

Use for web, desktop, mobile, extension and other interactive surfaces. Apply the
UI lifecycle in [workflow](workflow.md) when changing a product. A standalone
website mockup follows the same design craft without inventing a backend.

## Shape the experience

Read the existing system through [design system](design-system.md) only as needed.
Audit affected routes, domain objects, actions, permissions and real interfaces.
Make unknown behavior explicit. Determine the primary action and information
needed before it, then organize navigation, grouping and density around that task.

For an exploration, compare two or three materially different structures using
the same content and fixtures. Explain tradeoffs in task steps, discoverability,
space use and platform fit. For a requested revision, extend the selected design;
do not restart exploration or change unrelated visual language.

## Build the smallest executable prototype

Use the existing project stack for realistic component behavior when practical;
otherwise plain HTML/CSS/JS is sufficient. Add no build system for a single static
screen. Keep prototype-only files under the design destination. Use a local HTTP
preview, e.g. `python -m http.server 8000 --bind 127.0.0.1 --directory designs`,
with a free port and the project's prescribed runtime environment.

Use semantic controls with labels, visible focus and predictable tab order. Make
the core flow work with sanitized fixtures. Include relevant loading, empty,
error, disabled, permission, retry, cancellation and completion states. Keep state
controls outside exported product content. Distinguish simulation from production
effects in handoff notes; do not invent working integrations.

Use content-driven layout and responsive breakpoints. Check both narrow and wide
viewports, long content and zoom. A device frame is presentation chrome: test the
actual viewport and scroll behavior inside it. A native app mockup is not proof
of native accessibility, window management, menus or gestures.

## Review and handoff

Capture affected states at stable viewport sizes. Check hierarchy, alignment,
clipping, overflow, focus, contrast, text usefulness, and runtime errors. Use the
DOM collector and content inventory for browser UI; supplement it for canvas,
closed shadow roots, native dialogs and other opaque surfaces.

List every local visual/behavior dependency in the matching
`ui-contract.json` surface's `prototype.files`, including CSS, scripts, images,
fonts and fixtures. Keep them inside the design project; snapshot shared system
assets for an approved prototype and record their source. This freezes the
reviewed visual result without importing the design folder into production.

Present a usable preview, exact file, scope and missing checks. In the UI
workflow keep `needs-review` until the user approves this version. Do not infer
approval from a screenshot looking polished or a comment asking for more changes.
