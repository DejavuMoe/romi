.DEFAULT_GOAL := help
export CARGO_TARGET_DIR := $(CURDIR)/target
.PHONY: help setup frontend build release release-candidate release-package package check smoke bench bench-fixture dev-server dev-admin dev-web

help:
	@echo 'make setup       Install locked frontend dependencies and fetch Rust dependencies'
	@echo 'make build       Build both frontends, server and agent (debug)'
	@echo 'make check       Lint, typecheck/build frontends and run existing tests'
	@echo 'make smoke       Build and verify server + agent over loopback'
	@echo 'make bench       Run the storage benchmark against target/release (see scripts/bench.py)'
	@echo 'make bench-fixture  Build the benchmark-only large-history fixture/profiler'
	@echo 'make dev-server  Run server on 127.0.0.1:9911, data under .local/'
	@echo 'make dev-admin   Run admin HMR on 127.0.0.1:5173/admin/'
	@echo 'make dev-web     Run public web HMR on 127.0.0.1:5174/'
	@echo 'make release           Build local release binaries (no publishing)'
	@echo 'make package           Build a checksummed local development snapshot archive'
	@echo 'make release-candidate Build/verify a release-shaped candidate for x86_64-unknown-linux-gnu'
	@echo 'make release-package   Package HEAD as a public release; requires TAG=vX.Y.Z'
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
	mkdir -p server/target/theme
	rm -rf server/target/theme/dist
	cp -R web/dist server/target/theme/dist
	cp web/theme.json web/preview.png server/target/theme/

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

check: frontend
	python3 scripts/version.py check
	python3 scripts/release.py check
	python3 scripts/package.py check
	python3 scripts/test_installers.py
	pnpm --dir admin run lint
	pnpm --dir admin test
	pnpm --dir web run lint
	pnpm --dir web test
	cargo fmt --manifest-path server/Cargo.toml --all --check
	cargo fmt --manifest-path agent/Cargo.toml --all --check
	cargo clippy --locked --manifest-path server/Cargo.toml --all-targets -- -D warnings
	cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets -- -D warnings
	# ponytail: upstream tests share static gates; serialize until those tests isolate their gates.
	cargo test --locked --manifest-path server/Cargo.toml -- --test-threads=1
	cargo test --locked --manifest-path agent/Cargo.toml

smoke: build
	python3 scripts/smoke.py

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
