# romi contributor contract

Read `docs/README.md`, then the relevant requirement, module and test. Read only the documents needed for the change.

## Authority and boundaries

- Production code and tests define current behavior. The approved interface in `designs/romi-next/` defines UI intent.
- romi has its own requirements and release process. External projects are references, not development baselines or release gates.
- Keep the Linux probe boundary and DuckDB. Preserve authentication, privacy, input limits, data integrity and required third-party notices.
- Keep prompts, task transcripts, temporary plans and invented verification results out of product code and project documentation.

## Work

- Edit source and perform Git operations in the Windows checkout. Use `linux-task.ps1 -Mode build -Project <repo> -Command '<command>'` for Linux builds/tests.
- Never copy `.git` into WSL, edit only a build mirror, or synchronize two build jobs for this project concurrently.
- Start with an acceptance check. Reuse existing code and dependencies; prefer a small complete change over new layers.
- Visible UI changes use the project-local `prototype-first-ui` skill. Separate prototype, approval and implementation commits. Do not import prototype runtimes or fixtures into production.
- Update the document that owns a changed fact; use `docs/README.md` to find it. Remove stale statements instead of appending another status narrative.

## Verify and deliver

- Frontend/shared: `make frontend check-frontends`, then affected E2E against a freshly built Hub.
- Rust/storage: relevant Cargo tests and integration checks. `make check-linux` is the broad Linux gate.
- Packaging: run changed script checks. Git-mutating fixtures run on Windows or disposable CI, never in the WSL build mirror.
- Commit focused changes with Conventional Commits. Report executed checks, remaining limitations and exact branch/commit.
- History replacement, remote mutation and publishing require explicit authorization and the applicable recovery/release procedure.

See `docs/engineering.md` for phases and `docs/testing.md` for commands.
