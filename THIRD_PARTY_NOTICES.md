# Third-party notices

romi is derived from the following MIT-licensed projects by stqfdyr:

| Upstream | Imported location | Original license |
| --- | --- | --- |
| [monitor-probe/monitor](https://github.com/monitor-probe/monitor) | `server/`, `admin/` | `server/LICENSE`, copied to `admin/LICENSE` |
| [monitor-probe/agent](https://github.com/monitor-probe/agent) | `agent/` | `agent/LICENSE` |
| [monitor-probe/monitor-theme-default](https://github.com/monitor-probe/monitor-theme-default) | `web/` | `web/LICENSE` |

All original copyright and MIT license notices are retained. Root `LICENSE`
adds the romi contributors' modifications notice; it does not replace upstream ownership.
Exact revisions, import date and license SHA-256 hashes are in `upstream.lock.json`.
Archived upstream automation and installer files under `docs/upstream/` are also covered
by the corresponding upstream license.

Rust/npm dependencies and bundled fonts, icons and images retain their own licenses.
This file records the source imports, not a complete dependency license audit or SBOM.
Before public distribution, inventory the actual bundled dependencies/assets and include
all required third-party notices in binary, container and frontend distributions.
