#!/bin/sh
# romi Hub native installer.
#
# Consume an already-verified romi release archive. This script never downloads
# source or binaries; it stages the release under /opt/romi, installs the
# local Agent artifact for Hub-served provisioning, and only then starts the
# systemd service.
set -eu
umask 077

die() {
    printf 'romi-hub-install: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat >&2 <<'USAGE'
Usage: install.sh --site https://hub.example.com [options]

Options:
  --site URL           external HTTPS domain that reaches this Hub (required)
  --port PORT          loopback listener port (default 28080)
  --root-prefix DIR    test mode: install under DIR, no users or systemd
  --no-start           stage and switch files without starting the service
  --init SYSTEM          auto, systemd or openrc (default auto)
  --require-systemd    fail unless systemctl is available
  -h, --help           show this help
USAGE
}

need_value() {
    [ "$#" -ge 2 ] || die "$1 needs a value"
}

systemd_analyze_verify() {
    _unit=$1
    _name=${_unit##*/}
    _status=0
    _output=$(systemd-analyze verify "$_unit" 2>&1) || _status=$?
    _status=${_status:-0}
    if [ "$_status" -eq 0 ]; then
        return 0
    fi
    # systemd-analyze verify recurses into host units. Ignore failures that do
    # not name this generated unit, but never hide a failure that implicates
    # it.
    case "$_output" in
        *"$_unit"*|*"$_name"*)
            printf '%s\n' "$_output" >&2
            return 1
            ;;
    esac
    return 0
}

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || SCRIPT_DIR=.
RELEASE_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." 2>/dev/null && pwd -P) || die "cannot locate the release root"
HUB_USER=romi
HUB_GROUP=romi
DEFAULT_PORT=28080

SITE=
PORT=$DEFAULT_PORT
ROOT_PREFIX=
START=1
REQUIRE_SYSTEMD=0
INIT_SYSTEM=auto
SERVICE_NAME=romi-hub

validate_site() {
    _raw=$1
    [ -n "$_raw" ] || die "--site is required"
    case "$_raw" in
        *[![:graph:]]*) die "site URL contains whitespace or control characters" ;;
        https://*) _rest=${_raw#https://} ;;
        *) die "site URL must start with https://" ;;
    esac
    [ -n "$_rest" ] || die "site URL has no host"
    _authority=${_rest%%/*}
    _path=${_rest#"$_authority"}
    case "$_authority" in
        ''|*@*) die "site URL must be a domain without userinfo" ;;
        *\?*|*#*) die "site URL must not contain a query or fragment" ;;
    esac
    case "$_path" in
        ''|'/') ;;
        *) die "site URL must not contain a path" ;;
    esac
    _host=$_authority
    case "$_host" in
        \[*\]*) die "site URL must be a domain, not an IPv6 address" ;;
        *:*) _host=${_host%:*} ;;
    esac
    case "$_host" in
        ''|*[!A-Za-z0-9.-]*) die "site URL contains an invalid domain name" ;;
        *.*) ;;
        *) die "site URL must be a domain name, not an IP address" ;;
    esac
    case "$_host" in
        *[!0-9.]*) ;;
        *) die "site URL must be a domain name, not an IP address" ;;
    esac
    case "$_host" in
        localhost|*.localhost) die "site URL must be a real external domain" ;;
    esac
    SITE=${_raw%/}
}

json_string_field() {
    _file=$1
    _key=$2
    tr -d '\n' < "$_file" | sed -n 's/.*"'"$_key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

write_unit() {
    _dst=$1
    _template=$SCRIPT_DIR/romi-hub.service.in
    if [ "$INIT_SYSTEM" = openrc ]; then _template=$SCRIPT_DIR/romi-hub.openrc.in; fi
    [ -r "$_template" ] || die "missing service template: $_template"
    sed -e "s|@ROMI_HUB_BIN@|$OPT_CURRENT/romi-hub|g" \
        -e "s|@ROMI_HUB_ENV@|$HUB_ENV|g" \
        -e "s|@ROMI_PORT@|$PORT|g" \
        -e "s|@ROMI_STATE_DIR@|$STATE_DIR|g" \
        -e "s|@ROMI_DISTRIBUTION_DIR@|$DIST_DIR|g" \
        "$_template" > "$_dst"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --site)
            need_value "$@"; SITE=$2; shift 2 ;;
        --port)
            need_value "$@"; PORT=$2; shift 2 ;;
        --root-prefix)
            need_value "$@"; ROOT_PREFIX=$2; shift 2 ;;
        --no-start)
            START=0; shift ;;
        --init)
            need_value "$@"; INIT_SYSTEM=$2; shift 2 ;;
        --require-systemd)
            REQUIRE_SYSTEMD=1; shift ;;
        -h|--help)
            usage; exit 0 ;;
        *)
            die "unknown argument: $1" ;;
    esac
done

case "$PORT" in
    ''|*[!0-9]*) die "--port must be a number from 1 to 65535" ;;
esac
if [ "$PORT" -ge 1 ] 2>/dev/null && [ "$PORT" -le 65535 ]; then
    :
else
    die "--port must be 1-65535"
fi
case "$ROOT_PREFIX" in
    *'&'*|*'|'*|*[[:space:]]*) die "--root-prefix may not contain whitespace, & or |" ;;
esac
if [ -z "$ROOT_PREFIX" ]; then
    [ "$(id -u)" = 0 ] || die "must run as root; use --root-prefix for a test installation"
else
    START=0
    ROOT_PREFIX=${ROOT_PREFIX%/}
fi
if [ "$REQUIRE_SYSTEMD" = 1 ]; then INIT_SYSTEM=systemd; fi
case "$INIT_SYSTEM" in
    auto)
        if command -v systemctl >/dev/null 2>&1; then INIT_SYSTEM=systemd
        elif command -v rc-service >/dev/null 2>&1; then INIT_SYSTEM=openrc
        elif [ -n "$ROOT_PREFIX" ]; then INIT_SYSTEM=systemd
        else die "systemd or OpenRC is required"; fi ;;
    systemd|openrc) ;;
    *) die "--init must be auto, systemd or openrc" ;;
esac
if [ -z "$ROOT_PREFIX" ] || [ "$REQUIRE_SYSTEMD" = 1 ]; then
    if [ "$INIT_SYSTEM" = systemd ]; then
        command -v systemctl >/dev/null 2>&1 || die "systemd is required (systemctl not found)"
    else
        command -v rc-service >/dev/null 2>&1 || die "OpenRC is required (rc-service not found)"
        command -v supervise-daemon >/dev/null 2>&1 || die "OpenRC supervise-daemon is required"
    fi
fi

service_active() {
    if [ "$INIT_SYSTEM" = systemd ]; then systemctl is-active --quiet "$SERVICE_NAME.service"
    else rc-service "$SERVICE_NAME" status >/dev/null 2>&1; fi
}
service_stop() {
    if [ "$INIT_SYSTEM" = systemd ]; then systemctl stop "$SERVICE_NAME.service"
    else rc-service "$SERVICE_NAME" stop; fi
}
service_start() {
    if [ "$INIT_SYSTEM" = systemd ]; then
        systemctl daemon-reload
        systemctl enable "$SERVICE_NAME.service"
        systemctl restart "$SERVICE_NAME.service"
    else
        rc-update add "$SERVICE_NAME" default
        rc-service "$SERVICE_NAME" restart
    fi
}
service_diagnostics() {
    if [ "$INIT_SYSTEM" = systemd ]; then
        systemctl status --no-pager "$SERVICE_NAME.service" >&2 || true
        journalctl -u "$SERVICE_NAME.service" -n 30 --no-pager >&2 || true
    else
        rc-service "$SERVICE_NAME" status >&2 || true
        tail -n 30 "/var/log/$SERVICE_NAME.log" >&2 || true
    fi
}

validate_site "$SITE"

BIN_HUB=$RELEASE_ROOT/bin/romi-hub
BIN_AGENT=$RELEASE_ROOT/bin/romi-agent
VERSION_FILE=$RELEASE_ROOT/VERSION
RELEASE_JSON=$RELEASE_ROOT/release.json
[ -x "$BIN_HUB" ] || die "release is missing bin/romi-hub"
[ -x "$BIN_AGENT" ] || die "release is missing bin/romi-agent"
[ -r "$VERSION_FILE" ] || die "release is missing VERSION"
[ -r "$RELEASE_JSON" ] || die "release is missing release.json"
version=$(cat "$VERSION_FILE")
case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "VERSION is not X.Y.Z: $version" ;;
esac
component=$(json_string_field "$RELEASE_JSON" component)
kind=$(json_string_field "$RELEASE_JSON" kind)
target=$(json_string_field "$RELEASE_JSON" target)
release_version=$(json_string_field "$RELEASE_JSON" version)
[ "$component" = "hub" ] || die "this installer requires a Hub release archive"
[ "$kind" = "public-release" ] || die "this installer refuses a release candidate; verify and use a published romi release"
[ "$release_version" = "$version" ] || die "release.json version does not match VERSION"
case "$target" in
    x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu|x86_64-unknown-linux-musl|aarch64-unknown-linux-musl) ;;
    *) die "unsupported release target: $target" ;;
esac
architecture=${target%%-*}

hub_reported=$("$BIN_HUB" --version 2>/dev/null) || die "released romi-hub cannot execute on this host"
[ "$hub_reported" = "romi-hub $version" ] || die "released romi-hub reports '$hub_reported'"
agent_reported=$("$BIN_AGENT" --version 2>/dev/null) || die "released romi-agent cannot execute on this host"
[ "$agent_reported" = "romi-agent $version" ] || die "released romi-agent reports '$agent_reported'"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"


WORK=$(mktemp -d "${TMPDIR:-/tmp}/romi-hub-install.XXXXXX") || die "cannot create a temporary directory"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

# Layout: immutable releases under /opt, mutable state under /var/lib, config
# under /etc. ROOT_PREFIX is empty in production.
#
# The component name is part of the path because a hub and an agent are
# routinely installed on the same machine -- the hub's own host is monitored
# like any other. Sharing /opt/romi/current made the second installer point that
# one symlink at its own release, so installing or upgrading the agent broke the
# hub at its next restart, and the hub installer refused outright when the agent
# had already claimed the version directory.
OPT_ROOT="$ROOT_PREFIX/opt/romi/hub"
OPT_RELEASES="$OPT_ROOT/releases"
OPT_VERSION="$OPT_RELEASES/$version"
OPT_CURRENT="$OPT_ROOT/current"
STATE_DIR="$ROOT_PREFIX/var/lib/romi"
DIST_ROOT="$STATE_DIR/distribution"
DIST_DIR="$DIST_ROOT/$version"
ETC_DIR="$ROOT_PREFIX/etc/romi"
HUB_ENV="$ETC_DIR/hub.env"
UNIT_PATH="$ROOT_PREFIX/etc/systemd/system/romi-hub.service"
UNIT_MODE=0644
if [ "$INIT_SYSTEM" = openrc ]; then
    UNIT_PATH="$ROOT_PREFIX/etc/init.d/romi-hub"
    UNIT_MODE=0755
fi

REAL_SYSTEM=0
if [ -z "$ROOT_PREFIX" ]; then
    REAL_SYSTEM=1
    if grep -q "^$HUB_GROUP:" /etc/group; then
        :
    else
        if command -v groupadd >/dev/null 2>&1; then groupadd --system "$HUB_GROUP"
        else addgroup -S "$HUB_GROUP"; fi
    fi
    if id -u "$HUB_USER" >/dev/null 2>&1; then
        :
    else
        if command -v useradd >/dev/null 2>&1; then
            useradd --system --gid "$HUB_GROUP" --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$HUB_USER"
        else
            adduser -S -D -H -G "$HUB_GROUP" -h "$STATE_DIR" -s /sbin/nologin "$HUB_USER"
        fi
    fi
fi

# Root-controlled release and distribution directories; Hub-owned state
# directories retain anything already present.
install -d -m 0755 "$OPT_ROOT" "$OPT_RELEASES"
install -d -m 0750 "$STATE_DIR"
# DuckDB spill files contain database rows; match the Hub's owner-only policy.
install -d -m 0700 "$STATE_DIR/tmp"
install -d -m 0750 "$DIST_ROOT"
install -d -m 0750 "$ETC_DIR"
if [ "$REAL_SYSTEM" = 1 ]; then
    chown "$HUB_USER:$HUB_GROUP" "$STATE_DIR" "$STATE_DIR/tmp"
    chown "root:$HUB_GROUP" "$DIST_ROOT" "$ETC_DIR"
fi

if [ -e "$OPT_VERSION" ]; then
    [ -x "$OPT_VERSION/romi-hub" ] || die "$OPT_VERSION exists but has no runnable Hub"
    installed_hub=$(sha256sum "$OPT_VERSION/romi-hub" | cut -d' ' -f1)
    source_hub=$(sha256sum "$BIN_HUB" | cut -d' ' -f1)
    installed_agent=$(sha256sum "$OPT_VERSION/romi-agent" | cut -d' ' -f1)
    source_agent=$(sha256sum "$BIN_AGENT" | cut -d' ' -f1)
    if [ "$installed_hub" = "$source_hub" ] && [ "$installed_agent" = "$source_agent" ]; then
        :
    else
        die "$OPT_VERSION contains different binaries; refusing to replace an immutable release"
    fi
else
    stage="$OPT_RELEASES/.${version}.tmp.$$"
    [ ! -e "$stage" ] || die "temporary release path already exists: $stage"
    install -d -m 0755 "$stage"
    install -m 0755 "$BIN_HUB" "$stage/romi-hub"
    install -m 0755 "$BIN_AGENT" "$stage/romi-agent"
    install -m 0644 "$VERSION_FILE" "$stage/VERSION"
    install -m 0644 "$RELEASE_JSON" "$stage/release.json"
    mv "$stage" "$OPT_VERSION" || { rm -rf "$stage"; die "cannot install $OPT_VERSION"; }
fi

# Copy the exact same-release Agent into the Hub's local distribution. The Hub
# reads this root-controlled copy at startup and never contacts GitHub. Stage
# every mutable copy under a temporary name first so an interrupted reinstall
# cannot leave a half-written binary or metadata file in place.
agent_size=$(wc -c < "$BIN_AGENT" | tr -d ' ')
agent_sha=$(sha256sum "$BIN_AGENT" | cut -d' ' -f1)
dist_tmp="$WORK/distribution.json"
printf '{"format":1,"project":"romi","kind":"agent-distribution","version":"%s","target":"%s","architecture":"%s","filename":"romi-agent","sha256":"%s","size":%s}\n' \
    "$version" "$target" "$architecture" "$agent_sha" "$agent_size" > "$dist_tmp"
dist_stage="$DIST_ROOT/.${version}.tmp.$$"
[ ! -e "$dist_stage" ] || die "temporary distribution path already exists: $dist_stage"
install -d -m 0750 "$dist_stage"
install -m 0640 "$BIN_AGENT" "$dist_stage/romi-agent"
install -m 0640 "$dist_tmp" "$dist_stage/distribution.json"
if [ "$REAL_SYSTEM" = 1 ]; then
    chown "root:$HUB_GROUP" "$dist_stage" "$dist_stage/romi-agent" "$dist_stage/distribution.json"
fi
# Other supported Agents travel in the verified Hub archive, never from a
# mutable remote download. Each target has separate metadata and immutable URL.
for agent_target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
    [ "$agent_target" != "$target" ] || continue
    extra="$RELEASE_ROOT/agents/$agent_target/romi-agent"
    [ -f "$extra" ] || continue
    extra_dir="$dist_stage/$agent_target"
    install -d -m 0750 "$extra_dir"
    install -m 0640 "$extra" "$extra_dir/romi-agent"
    extra_sha=$(sha256sum "$extra" | cut -d' ' -f1)
    extra_size=$(wc -c < "$extra" | tr -d ' ')
    printf '{"format":1,"project":"romi","kind":"agent-distribution","version":"%s","target":"%s","architecture":"%s","filename":"romi-agent","sha256":"%s","size":%s}\n' \
        "$version" "$agent_target" "${agent_target%%-*}" "$extra_sha" "$extra_size" > "$extra_dir/distribution.json"
    chmod 0640 "$extra_dir/distribution.json"
    if [ "$REAL_SYSTEM" = 1 ]; then
        chown "root:$HUB_GROUP" "$extra_dir" "$extra_dir/romi-agent" "$extra_dir/distribution.json"
    fi
done
if [ -e "$DIST_DIR" ]; then
    [ -d "$DIST_DIR" ] || die "$DIST_DIR exists but is not a directory"
    mv -f "$dist_stage/romi-agent" "$DIST_DIR/romi-agent"
    mv -f "$dist_stage/distribution.json" "$DIST_DIR/distribution.json"
    for agent_target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
        [ -d "$dist_stage/$agent_target" ] || continue
        install -d -m 0750 "$DIST_DIR/$agent_target"
        mv -f "$dist_stage/$agent_target/romi-agent" "$DIST_DIR/$agent_target/romi-agent"
        mv -f "$dist_stage/$agent_target/distribution.json" "$DIST_DIR/$agent_target/distribution.json"
        if [ "$REAL_SYSTEM" = 1 ]; then chown "root:$HUB_GROUP" "$DIST_DIR/$agent_target"; fi
        rmdir "$dist_stage/$agent_target"
    done
    rmdir "$dist_stage"
else
    mv "$dist_stage" "$DIST_DIR" || { rm -rf "$dist_stage"; die "cannot install $DIST_DIR"; }
fi

env_tmp="$WORK/hub.env"
env_stage="$ETC_DIR/.hub.env.$$"
[ ! -e "$env_stage" ] || die "temporary environment path already exists: $env_stage"
printf 'ROMI_SITE=%s\n' "$SITE" > "$env_tmp"
install -m 0640 "$env_tmp" "$env_stage"
if [ "$REAL_SYSTEM" = 1 ]; then
    chown "root:$HUB_GROUP" "$env_stage"
fi
mv -f "$env_stage" "$HUB_ENV"

unit_tmp="$WORK/romi-hub.service"
write_unit "$unit_tmp"
if [ "$REAL_SYSTEM" = 1 ] && [ "$INIT_SYSTEM" = systemd ] && command -v systemd-analyze >/dev/null 2>&1; then
    # Verify the exact generated hardening and argument list against the staged
    # binary. The installed unit points at current/, which may not exist yet on
    # a first install; current/ is switched only after verification.
    verify_unit="$WORK/romi-hub.verify.service"
    sed "s|$OPT_CURRENT/romi-hub|$OPT_VERSION/romi-hub|g" "$unit_tmp" > "$verify_unit"
    systemd_analyze_verify "$verify_unit" || die "generated service unit failed systemd-analyze verify"
fi
install -d -m 0755 "$(dirname "$UNIT_PATH")"
unit_stage="$UNIT_PATH.$$"
[ ! -e "$unit_stage" ] || die "temporary unit path already exists: $unit_stage"
install -m "$UNIT_MODE" "$unit_tmp" "$unit_stage"
if [ "$REAL_SYSTEM" = 1 ]; then
    chown "root:root" "$unit_stage"
fi
mv -f "$unit_stage" "$UNIT_PATH"

if [ "$REAL_SYSTEM" = 1 ]; then
    if service_active; then
        service_stop
    fi
fi

# Atomic switch. The previous release directory remains available for an
# operator-directed rollback; the database always lives under /var/lib/romi and
# is never touched by a release switch.
link_tmp="$OPT_ROOT/.current.$$"
[ ! -e "$link_tmp" ] || rm -f "$link_tmp"
ln -s "releases/$version" "$link_tmp"
mv -Tf "$link_tmp" "$OPT_CURRENT" || die "cannot atomically switch $OPT_CURRENT"

if [ "$REAL_SYSTEM" = 0 ] || [ "$START" = 0 ]; then
    printf 'romi Hub %s staged at %s\n' "$version" "$OPT_VERSION"
    printf 'bootstrap credential will be written to %s on first start\n' "$STATE_DIR/bootstrap-password"
    if [ "$START" = 0 ]; then
        printf 'service not started (--no-start or test mode)\n'
    fi
    exit 0
fi

service_start

attempt=0
while [ "$attempt" -lt 30 ]; do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        if [ -e "$STATE_DIR/bootstrap-password" ]; then
            printf 'romi Hub %s is active; bootstrap credential: %s\n' "$version" "$STATE_DIR/bootstrap-password"
        else
            printf 'romi Hub %s is active (existing database; bootstrap credential unchanged).\n' "$version"
        fi
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done
service_diagnostics
die "romi-hub did not become healthy; the new release is still selected. Previous binaries are in $OPT_RELEASES, but do not roll back after a database schema change without a compatible backup."
