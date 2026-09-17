.DEFAULT_GOAL := help
export CARGO_TARGET_DIR := $(CURDIR)/target
.PHONY: help setup frontend build release package check smoke dev-server dev-admin dev-web

help:
	@echo 'make setup       Install locked frontend dependencies and fetch Rust dependencies'
	@echo 'make build       Build both frontends, server and agent (debug)'
	@echo 'make check       Lint, typecheck/build frontends and run existing tests'
	@echo 'make smoke       Build and verify server + agent over loopback'
	@echo 'make dev-server  Run server on 127.0.0.1:9911, data under .local/'
	@echo 'make dev-admin   Run admin HMR on 127.0.0.1:5173/admin/'
	@echo 'make dev-web     Run public web HMR on 127.0.0.1:5174/'
	@echo 'make release     Build local release binaries (no publishing)'
	@echo 'make package     Build a checksummed local snapshot archive'

setup:
	npm --prefix admin ci --no-audit --no-fund
	npm --prefix web ci --no-audit --no-fund
	cargo fetch --locked --manifest-path server/Cargo.toml
	cargo fetch --locked --manifest-path agent/Cargo.toml

frontend:
	npm --prefix admin run build
	npm --prefix web run build
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
	npm --prefix admin run lint
	npm --prefix admin test
	npm --prefix web run lint
	npm --prefix web test
	cargo fmt --manifest-path server/Cargo.toml --all --check
	cargo fmt --manifest-path agent/Cargo.toml --all --check
	cargo clippy --locked --manifest-path server/Cargo.toml --all-targets -- -D warnings
	cargo clippy --locked --manifest-path agent/Cargo.toml --all-targets -- -D warnings
	# ponytail: upstream tests share static gates; serialize until those tests isolate their gates.
	cargo test --locked --manifest-path server/Cargo.toml -- --test-threads=1
	cargo test --locked --manifest-path agent/Cargo.toml

smoke: build
	python3 scripts/smoke.py

dev-server:
	mkdir -p .local
	cargo run --locked --manifest-path server/Cargo.toml -- --listen 127.0.0.1:9911 --db .local/romi.db

dev-admin:
	npm --prefix admin run dev -- --host 127.0.0.1 --port 5173 --strictPort

dev-web:
	npm --prefix web run dev -- --host 127.0.0.1 --port 5174 --strictPort
