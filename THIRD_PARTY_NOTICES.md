# Third-party notices

romi is derived from the following MIT-licensed projects by stqfdyr:

| Upstream | Imported location | Original license |
| --- | --- | --- |
| [monitor-probe/monitor](https://github.com/monitor-probe/monitor) | `server/`, `admin/` | `server/LICENSE`, copied to `admin/LICENSE` |
| [monitor-probe/agent](https://github.com/monitor-probe/agent) | `agent/` | `agent/LICENSE` |
| [monitor-probe/monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | `web/` | `web/LICENSE` |

All original copyright and MIT license notices are retained. Root `LICENSE`
includes Copyright (c) 2026 Dejavu Moe alongside the original author's notice.
Exact revisions, import date and license SHA-256 hashes are in `upstream.lock.json`.
Archived upstream automation and installer files under `docs/upstream/` are also covered
by the corresponding upstream license.

Public `romi-hub` and `romi-agent` release archives include this file, the root MIT
license, and the applicable imported-component licenses (`server/LICENSE`,
`admin/LICENSE`, `web/LICENSE`, `agent/LICENSE`). The inherited product names in the
tables above identify upstream sources, not the current binaries.

Rust/JavaScript dependencies and bundled fonts, icons and images retain their own licenses.
This file records the source imports, not a complete dependency license audit or SBOM.
Before public distribution, inventory the actual bundled dependencies/assets and include
all required third-party notices in binary, container and frontend distributions.

## Storage engine

The Hub embeds [DuckDB](https://duckdb.org/) through the official Rust client
[`duckdb`](https://crates.io/crates/duckdb) with the `bundled` feature, which compiles the
DuckDB source the crate vendors into the binary. Both are MIT licensed:

| Component | Version | License |
| --- | --- | --- |
| `duckdb` (Rust crate) | `1.10505.0` | MIT |
| `libduckdb-sys` (build/bindings) | `1.10505.0` | MIT |
| DuckDB engine (compiled in) | `v1.5.5` | MIT |

Arrow crates arrive transitively through `libduckdb-sys`'s bundled build; they are
Apache-2.0. `server/Cargo.lock` records the exact revisions, and
`docs/storage.md` documents how this engine is used.
