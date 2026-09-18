# romi release readiness — v0.4C rehearsal

> Evidence log for the final release rehearsal before a possible `v0.1.0`.
> This document is not a release announcement and does not authorise a tag,
> GitHub Release, or attestation. The authoritative artifact and tag model is
> [release.md](release.md); deployment layout and trust boundaries are in
> [deployment.md](deployment.md).

## Evidence chain

- Expected and inspected starting commit: `a37f80ef2bcc4a7ab78bd1620f0ba7e47b03b380`
  (`feat(deploy): add verified native provisioning`).
- Starting remote CI run `35292740790` (`CI`, push) completed with **failure**:
  shellcheck rejected `deploy/hub/install.sh` with `SC2015` information findings.
- The defect was fixed locally by replacing the `A && B || C` forms with explicit
  `if` blocks. The remote CI run was not restarted because this phase forbids
  pushing commits.
- The pushed starting commit therefore is **not** release-ready by itself.
  The final commit of this phase must be pushed and re-run before publication.
- An existing remote `v0.1.0` tag was not present while the local rehearsal
  built artifacts; the local-tag wrapper fails closed if a remote tag appears.

## Checklist

| Area | State | Evidence |
| --- | --- | --- |
| Starting remote CI | **FAIL** | Run `35292740790` failed on shellcheck `SC2015`; fixed locally, remote re-run pending the user's push. |
| Local quality gate | **PASS** | `make check`: release/version/package/installer self-checks, frontend lint/build/test, Rust fmt, Clippy `-D warnings`, 150 server tests, 9 DuckDB integration tests, 20 Agent tests. |
| Loopback process smoke | **PASS** | `make smoke` and `scripts/smoke.py --bin-dir` against the controlled Ubuntu 22.04 release binaries: login, node creation, token rotation, Agent metrics, single-writer lock, `/healthz`, validated Agent distribution. |
| Remote release workflow dry run | **NOT TESTED** | Not triggered: the starting CI run was red and this phase does not permit pushes. |
| Public-release shape, local only | **PASS** | Local-only tag wrapper plus unchanged `scripts/release.py` built and verified both archives, `release.json`, whole-release manifest, `SHA256SUMS`, executable modes, member exclusions, and `--run-binaries`. The tag was not pushed. |
| Release artifact contents | **PASS** | Hub archive: `bin/romi-hub`, same-release `bin/romi-agent`, installers, unit template, licence/notices, `VERSION`, `release.json`. Agent archive: `bin/romi-agent`, installer, unit template, licence/notices, `VERSION`, `release.json`. No benchmark binary, database, credential, local snapshot, or machine path was found by the verifier. |
| GNU runtime baseline | **PASS (measured)** | Controlled Ubuntu 22.04 build with pinned Rust 1.98.0: `romi-hub` and `romi-agent` both max out at `GLIBC_2.34`. The public release workflow is pinned to `ubuntu-22.04` and now refuses a higher measured baseline. Ubuntu 20.04 / glibc 2.31 is not supported and was not claimed. |
| Real systemd Hub installation | **NOT TESTED / DEFERRED** | No isolated systemd VM or other non-intrusive disposable systemd host was available. The generated unit passes installer-side `systemd-analyze verify`, but `/opt/romi`, `/var/lib/romi`, service enable/start/restart, and real unit lifecycle were not exercised in this phase. |
| Bootstrap credential lifecycle | **PASS (process level) / systemd file layout NOT TESTED** | A real release Hub process with `--bootstrap-password-file` wrote a 0600 non-empty hex credential; the process log did not contain it; successful login worked; password change removed the file; old password returned 401; new password returned 200. |
| Real systemd Agent installation | **NOT TESTED / DEFERRED** | Requires the deferred root/systemd installation path. The installer was exercised through a real Hub-served `/install.sh` and a secondary root-prefix fixture. |
| Real Agent provisioning: permanent token | **PASS (process level)** | A real node token was created through the TLS-proxied admin API; the Hub-served installer consumed it with `--token-stdin`; `/etc/romi/agent.env` was 0600 and contained the token; the unit and process command line did not. The Agent process connected and reported telemetry. |
| Real Agent provisioning: registration window | **PASS (process level)** | A real window was opened through the authenticated Hub API; the Hub-served installer exchanged the key through the live Nginx/TLS route; the short-lived key was absent from `agent.env`; the distinct permanent token was stored and connected; closing the window caused the old key to be refused with 403. |
| Real telemetry | **PASS (process level)** | Exact-release Agent connected to the exact-release Hub over loopback and the Hub reported `online=true`, `agent_version=0.1.0`, and non-zero `mem_total`/CPU metrics. |
| Nginx/TLS reverse proxy | **PASS (process level)** | Nginx used the documented `proxy_pass`/Host/X-Forwarded-Proto/Upgrade directives; a local CA and SAN certificate were validated with `nginx -t`; HTTPS `/healthz`, login/session cookies, admin API, `/install.sh`, distribution metadata, versioned Agent binary, and frontend all succeeded. `curl -k` was not used by the checks. |
| WebSocket through Nginx | **PASS (process level)** | An authenticated `GET /api/ws` through the TLS Nginx route returned `HTTP/1.1 101 Switching Protocols`. |
| Direct-vs-proxy provisioning boundary | **PASS (process level)** | Authenticated provisioning through the proxy-shaped request (Host + `X-Forwarded-Proto: https`) succeeded; the same authenticated request straight to the loopback Hub with an IP Host was refused with 403. Native unit templates still bind `127.0.0.1`. |
| Idempotent installation | **PASS (process level) / systemd installer NOT TESTED** | Re-running the Agent installer for the same version reused the immutable binary, kept the `current` link and credential file unchanged, and the Agent stayed connected. |
| Hub restart, stop/start, database lock | **PASS (process level) / systemd NOT TESTED** | After a clean stop, a second Hub process opened the same DuckDB file and became healthy, proving the writer lock was released. After restart, the database inode and previously committed settings/telemetry were still readable and both real Agents reconnected. |
| Backup/restore | **PASS (process level + unit tests)** | `GET /api/db/backup` produced a real archive through the TLS proxy; mutating a setting then posting the archive to the chunked restore API restored it successfully. The storage suite includes the full backup/restore and refusal cases. Native systemd API round-trip is not separately re-tested. |
| Real systemd security review | **NOT TESTED / DEFERRED** | `systemd-analyze verify` is run by installer tests on generated root-prefix units, but `systemd-analyze security` on installed real units could not be run without the deferred systemd host. No numeric score is used as a release gate. |
| Provenance / attestation | **STRUCTURALLY REVIEWED / NOT EXECUTED** | `actions/attest` is pinned by full commit SHA; `id-token: write` and `attestations: write` exist only in the publish job; the subject set is all published release files; verification examples bind `DejavuMoe/romi`. No real attestation was created in this phase. |
| Remote-code execution regression | **PASS by audit** | Hub/Agent protocol accepts only `hello`, `report`, and `ping.result`; unknown methods are ignored. No shell/exec/file-write/package-manager/systemctl/Agent-update RPC exists. Installers are local administrator actions only. |
| Unsupported platform scope | **PASS** | Only `x86_64-unknown-linux-gnu` + systemd remains declared. No aarch64, musl, Alpine, OpenRC, Docker runtime, macOS, or Windows target was added. |
| Private / self-signed CA support | **DOCUMENTED LIMITATION** | Agent TLS uses rustls/webpki roots, so a private CA installed in the host OS trust store is not automatically trusted. No `--insecure` mode was added. A narrow `--ca-file` option remains a future feature. |

## Runtime-baseline experiment

The current public release build is pinned to `ubuntu-22.04` instead of
`ubuntu-24.04`. The controlled experiment used the same pinned Rust 1.98.0
toolchain and the same locked dependency graph in an offline Ubuntu 22.04
container, then ran the release binaries on Ubuntu 22.04:

- `romi-hub`: maximum `GLIBC_2.34` (previously `GLIBC_2.38`).
- `romi-agent`: maximum `GLIBC_2.34` (unchanged).
- `ldd` confirms no external `libduckdb`; DuckDB remains bundled.

This lowers the Hub baseline materially without introducing Zig, cross-build,
musl, or additional targets. Development CI remains on Ubuntu 24.04; only the
public release build is pinned to the older image. The release workflow measures
the symbols from the released binaries and refuses any value above 2.34, so a
runner/toolchain change cannot silently raise the baseline. Compatibility below
the measured 2.34 symbol requirement is not claimed.

## Known limitations and release blockers

1. **Real systemd rehearsal is still missing.** The native Hub/Agent installers,
   unit lifecycle, `/opt` and `/var/lib` ownership, bootstrap-file ownership
   under the real service account, service restart semantics, and
   `systemd-analyze security` have not been exercised on an isolated systemd
   host. Root-prefix fixture tests are not a substitute.
2. **The final commit has not been pushed.** Remote CI, the manual release
   dry-run, and the new manual release-rehearsal workflow cannot run until the
   user pushes the commit. The starting commit's CI is still red.
3. **Publication-time attestation is unproven.** The tag publish path was
   reviewed and only structurally tested. A real attestation and draft-release
   handoff can only be validated by the first authorised tag publication.
4. **Nginx/TLS was validated as a process-level route**, not by installing Nginx
   as a system package on the same real systemd host as the native Hub. The
   directives and TLS paths were real, but that final integration step remains.
5. **Older GNU distributions are unsupported.** The measured floor is glibc
   2.34. Ubuntu 20.04 and other glibc 2.31-era systems must not be claimed.

## Recommendation gate

The evidence chain is strong for build, artifact shape, process-level
provisioning, TLS, telemetry, reinstall, restart, and storage behaviour. It is
not complete for the operator path this phase was created to prove: a real
root/systemd installation from the exact public artifact. Until item 1 and the
remote CI/dry-run in item 2 are complete, the tree should be treated as
**NOT READY FOR v0.1.0**.
