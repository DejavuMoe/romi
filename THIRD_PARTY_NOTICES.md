# Third-party notices

romi is independently maintained by Dejavu Moe under the MIT license in [LICENSE](LICENSE).

## In the release binaries

The Hub binary statically links its Rust crates and DuckDB v1.5.5, built from source through the bundled
`duckdb`/`libduckdb-sys` 1.10505.0 crates together with DuckDB's own C/C++ third-party components, and it embeds
the built admin panel and status page with their JavaScript dependencies. The Agent binary links its own Rust crates.

[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) lists every one of these components with its version and
license, followed by the license texts. It is generated from the lockfiles by `scripts/third_party.py`, checked in CI,
and shipped in every release archive and in the Agent image under `/licenses/`.
License texts that the published packages do not carry themselves are kept in [licenses/](licenses/README.md).

The status page draws its globe and day map from land cells in `shared/land.ts`, rasterised from world-atlas 2.0.2
`land-110m.json` (ISC, Michael Bostock), which packages Natural Earth 1:110m land data (public domain).

The interface uses system fonts only; no font files are distributed.

## In the repository only

- Prototype vendor provenance and notices: `designs/romi-next/vendor/`.
- The MaxMind GeoIP2 Country test database (`GeoIP2-Country-Test.mmdb`, MIT) and its notice: `server/testdata/maxmind/`.
  It is used by tests and not shipped.
- Local development skills under `.agents/skills/` keep their own licenses: `baoyu-design` (MIT),
  `prototype-first-ui` (Apache-2.0) and `security-audit` (MIT, Cloudflare).

Exact dependency versions are in `server/Cargo.lock`, `agent/Cargo.lock` and `pnpm-lock.yaml`.
