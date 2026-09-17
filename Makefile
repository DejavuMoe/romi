.DEFAULT_GOAL := help
export CARGO_TARGET_DIR := $(CURDIR)/target
.PHONY: help setup frontend build release package check smoke bench legacy dev-server dev-admin dev-web

help:
	@echo 'make setup       Install locked frontend dependencies and fetch Rust dependencies'
	@echo 'make build       Build both frontends, server and agent (debug)'
	@echo 'make check       Lint, typecheck/build frontends and run existing tests'
	@echo 'make smoke       Build and verify server + agent over loopback'
	@echo 'make bench       Run the storage benchmark against target/release (see scripts/bench.py)'
	@echo 'make legacy      Verify the offline SQLite -> DuckDB migration end to end'
	@echo 'make dev-server  Run server on 127.0.0.1:9911, data under .local/'
	@echo 'make dev-admin   Run admin HMR on 127.0.0.1:5173/admin/'
	@echo 'make dev-web     Run public web HMR on 127.0.0.1:5174/'
	@echo 'make release     Build local release binaries (no publishing)'
	@echo 'make package     Build a checksummed local snapshot archive'
	@echo ''
	@echo 'The Hub links DuckDB from source, so a C/C++ toolchain (cc and c++) is'
	@echo 'required; nothing else is. Agent builds need neither.'

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

check: frontend
	python3 scripts/package.py check
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
	python3 scripts/test-legacy-migration.py

# The offline migration, on its own, against the debug binaries.
legacy: build
	python3 scripts/test-legacy-migration.py

# Release binaries, because an unoptimized DuckDB is roughly twenty times slower
# per row and the numbers would say nothing about a deployed hub.
bench: release
	python3 scripts/bench.py --bin-dir target/release

dev-server:
	mkdir -p .local
	cargo run --locked --manifest-path server/Cargo.toml -- --listen 127.0.0.1:9911 --db .local/romi.db

dev-admin:
	pnpm --dir admin run dev --host 127.0.0.1 --port 5173 --strictPort

dev-web:
	pnpm --dir web run dev --host 127.0.0.1 --port 5174 --strictPort
