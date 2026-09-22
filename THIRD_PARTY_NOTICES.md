# Third-party notices

romi is independently maintained by Dejavu Moe under the MIT license in [LICENSE](LICENSE).
Portions of distributed code retain third-party notices where applicable. These notices do not define a development baseline or an update policy.

DuckDB is compiled into the Hub through the bundled Rust client. `duckdb` and `libduckdb-sys` 1.10505.0 and DuckDB v1.5.5 use MIT; transitive Arrow crates use Apache-2.0.
Rust/JavaScript dependencies, fonts, icons, test data and local development skills retain their own licenses. Exact dependency versions are in the lockfiles.

Prototype vendor provenance and notices are in `designs/romi-next/vendor/`; the Country test fixture notice is in `server/testdata/maxmind/`.
This file is not a complete dependency SBOM. Distribution must include the notices required by the actual bundled components.
