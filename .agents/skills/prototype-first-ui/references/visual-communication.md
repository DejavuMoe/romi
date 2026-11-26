# Visual communication

Use for slides, designed documents, print pages, posters, social assets, diagrams,
and brand imagery. These are first-class deliverables; they do not require a
product UI contract or a production implementation commit.

## Brief and format

Identify the message, audience, reading context, source material and requested
format. Reuse project foundations and brand assets. Establish aspect ratio or
page size, editable source needs, and destination constraints before layout.
Missing evidence for a claim is a content gap, not permission to invent it.

| Medium | Design decisions | Verification |
|---|---|---|
| Slides | Narrative sequence; one main takeaway per slide; vary layouts to suit evidence; notes hold supporting detail | Read at presentation size; check ordering, speaker notes, overflow and actual export |
| Documents / print | Reading sequence, headings, grids, tables, captions, margins and pagination | Render every page; check splits, widows, image resolution, page size and links |
| Poster / social | One focal point, short hierarchy, crop-safe content and appropriate call to action | Inspect at intended size and thumbnail; check destination crop and contrast |
| Diagram | Explicit nodes/relationships, direction, grouping and legend | Verify claims and connection endpoints; readable labels without crossings/overlap |
| Brand imagery | Subject, composition, role in layout and reusable art direction | Check identity consistency, asset rights, crop, resolution and transparency |

## Authoring

Use the requested native format through available tools when possible. Otherwise
HTML/CSS works for editable layouts, SVG for diagrams and vector artwork, and
existing project libraries for decks or document export. Do not build a custom
canvas/editor to satisfy an ordinary artifact request.

Keep text, tables, diagrams and exact numbers as editable objects where required.
Image generation is appropriate for illustrations, atmosphere, photography-like
scenes and bitmap assets; it is optional. Without it, use available authorized
assets or a clearly disclosed substitute. Never claim an image was generated or
an attachment inspected when the tool was unavailable.

Match the medium rather than reusing a dashboard layout everywhere. Slides need
viewing-distance type and deliberate sequencing; print needs physical page
geometry; diagrams need semantic connections; brand assets need consistency
across sizes. A shared visual language does not require identical layouts.

Motion should explain order, change or emphasis. Preserve a readable static and
reduced-motion result; verify final animation states in exports. Do not add audio
or animation merely because a tool supports it.

## Revision and delivery

Use stable slide/page/element identifiers when feedback targets a part of the
artifact. Re-read the source before editing, preserve untouched pages and user
changes, and report any requested font/effect/export feature that could not be
preserved. Keep review notes outside the artifact unless explicitly requested.

Use [delivery](delivery.md). A PDF or PNG export does not satisfy an editable PPTX
request. If that exporter is missing, say so and provide usable source, not a
misnamed file. A slide deck should be verified as a deck, not through fabricated
UI states or route mappings.
