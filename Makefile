.DEFAULT_GOAL := help
export CARGO_TARGET_DIR := $(CURDIR)/target
.PHONY: help setup frontend build release release-candidate release-package release-rehearsal systemd-rehearsal package check check-linux smoke e2e bench bench-fixture dev-server dev-admin dev-web
.PHONY: check-scripts check-frontends check-format check-clippy check-rust-tests check-release-scripts

help:
	@echo 'make setup       Install locked frontend dependencies and fetch Rust dependencies'
	@echo 'make build       Build both frontends, server and agent (debug)'
	@echo 'make check       Lint, typecheck/build frontends and run existing tests'
	@echo 'make check-linux Run runtime checks without Git metadata or Git-mutating release fixtures'
	@echo 'make smoke       Build and verify server + agent over loopback'
	@echo 'make e2e         Build and run desktop/mobile browser tests against a temporary Hub'
	@echo 'make bench       Run the storage benchmark against target/release (see scripts/bench.py)'
	@echo 'make bench-fixture  Build the benchmark-only large-history fixture/profiler'
	@echo 'make dev-server  Run server on 127.0.0.1:9911, data under .local/'
	@echo 'make dev-admin   Run admin HMR on 127.0.0.1:5173/admin/'
	@echo 'make dev-web     Run public web HMR on 127.0.0.1:5174/'
	@echo 'make release           Build local release binaries (no publishing)'
	@echo 'make package           Build a checksummed local development snapshot archive'
	@echo 'make release-candidate Build/verify a release-shaped candidate for x86_64-unknown-linux-gnu'
	@echo 'make release-package   Package HEAD as a public release; requires TAG=vX.Y.Z'
	@echo 'make release-rehearsal Build/verify exact public-release shape using a local-only tag (never pushed)'
	@echo 'make systemd-rehearsal Run the real systemd rehearsal from dist/release (requires root; 127.0.0.1:28080 free)'
	@echo ''
	@echo 'The Hub links DuckDB from source, so a C/C++ toolchain (cc and c++) is'
	@echo 'required; nothing else is. Agent builds need neither. Public release'
	@echo 'packaging refuses a dirty tree; see docs/release.md.'

setup:
	pnpm install --frozen-lockfile
	cargo fetch --locked --manifest-path server/Cargo.toml
	cargo fetch --locked --manifest-path agent/Cargo.toml

frontend:
	pnpm --dir admin run build
	pnpm --dir web run build
	rm -rf server/target/theme
	mkdir -p server/target/theme
	cp -R web/dist server/target/theme/dist

build: frontend
	cargo build --locked --manifest-path server/Cargo.toml
	cargo build --locked --manifest-path agent/Cargo.toml

release: frontend
	cargo build --locked --release --manifest-path server/Cargo.toml
	cargo build --locked --release --manifest-path agent/Cargo.toml
	python3 scripts/package.py record

package: release
	python3 scripts/package.py build

# A public-release-shaped candidate: exact VERSION, exact HEAD commit, clean
# worktree, but no Git tag is created and nothing is published. The release
# workflow's manual dry-run uses the same candidate path.
release-candidate: release
	python3 scripts/release.py package --candidate

# Public packaging requires an existing tag whose commit is HEAD; this does
# not push or publish anything.
release-package: release
	@test -n "$(TAG)" || { echo 'usage: make release-package TAG=vX.Y.Z' >&2; exit 2; }
	python3 scripts/release.py package --tag "$(TAG)"

# Non-publishing public-shape rehearsal. The wrapper creates a lightweight tag
# in this checkout only after proving the remote tag does not exist, invokes the
# unchanged public packager, and deletes that local tag.
release-rehearsal: release
	python3 scripts/rehearse_release.py package

# Manual-only, destructive, real systemd rehearsal. Run only on a disposable
# host with no existing /opt/romi, /var/lib/romi or /etc/romi state.
systemd-rehearsal:
	@test "$$(id -u)" = 0 || { echo 'systemd-rehearsal must run as root on a disposable host' >&2; exit 2; }
	python3 scripts/systemd_rehearsal.py

check: check-linux
	$(MAKE) check-release-scripts

check-release-scripts:
	python3 scripts/release.py check
	python3 scripts/test_release_matrix.py
	python3 scripts/rehearse_release.py check
	python3 scripts/package.py check

# Build mirrors contain no .git. Release self-tests also mutate temporary Git
# repositories, so keep them in check (CI), outside the Windows-owned WSL path.
check-linux: frontend
	$(MAKE) check-scripts
	$(MAKE) check-frontends
	$(MAKE) check-format
	$(MAKE) check-clippy
	$(MAKE) check-rust-tests

# Component gates share the same commands with CI measurements. The entry point
# above builds the frontend once and preserves the original serial gate order.
check-scripts:
	python3 scripts/ci_ablation.py --self-check
	python3 scripts/test_bench_transport.py
	python3 scripts/test_release_gate.py
	python3 scripts/version.py check
	python3 scripts/test_installers.py
	python3 scripts/test_systemd_rehearsal.py
	python3 scripts/systemd_rehearsal.py --help >/dev/null

check-frontends:
	node shared/contract.test.ts
	./admin/node_modules/.bin/oxlint shared
	pnpm --dir admin run lint
	./admin/node_modules/.bin/oxlint e2e playwright.config.mjs
	pnpm --dir admin test
	pnpm --dir web run lint
	pnpm --dir web test

check-format:
	cargo fmt --manifest-path server/Cargo.toml --all --check
	cargo fmt --manifest-path agent/Cargo.toml --all --check

check-clippy:
	cargo clippy --locked --manifest-path server/Cargo.toml --all-targets -- -D warnings
	cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets -- -D warnings

check-rust-tests:
	# ponytail: tests still share process-global fault-injection/cache hooks; serialize until those are isolated.
	cargo test --locked --manifest-path server/Cargo.toml -- --test-threads=1
	cargo test --locked --manifest-path agent/Cargo.toml

smoke: build
	python3 scripts/smoke.py

e2e: build
	pnpm test:e2e

# Release binaries, because an unoptimized DuckDB is roughly twenty times slower
# per row and the numbers would say nothing about a deployed hub.
bench: release
	python3 scripts/bench.py --bin-dir target/release

# Benchmark-only fixture generator/profiler. Feature-gated so it never enters
# make release, make package, or the shipped binary; scripts/bench_analytics.py
# invokes it and drives the real HTTP endpoints.
bench-fixture:
	cargo build --locked --release --features bench --bin romi-bench --manifest-path server/Cargo.toml

dev-server:
	mkdir -p .local
	cargo run --locked --manifest-path server/Cargo.toml -- --listen 127.0.0.1:9911 --db .local/romi.db

dev-admin:
	pnpm --dir admin run dev --host 127.0.0.1 --port 5173 --strictPort

dev-web:
	pnpm --dir web run dev --host 127.0.0.1 --port 5174 --strictPort
