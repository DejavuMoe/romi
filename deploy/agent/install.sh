#!/bin/sh
# romi Agent native installer.
#
# This script is also embedded in the Hub binary and served from /install.sh.
# It never receives a permanent token in argv: the token is read from stdin or
# prompted for on the terminal, then written atomically to a 0600 environment
# file that systemd injects into the unprivileged Agent process.
set -eu
umask 077

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P) || SCRIPT_DIR=.
AGENT_USER=romi-agent
AGENT_GROUP=romi-agent

SERVER=
TOKEN_MODE=prompt
REGISTER_KEY=
INTERVAL=3
IFACE=
IFACE_SET=0
ROOT_PREFIX=
START=1
REQUIRE_SYSTEMD=0
INIT_SYSTEM=auto
SERVICE_NAME=romi-agent

die() {
    printf 'romi-agent-install: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat >&2 <<'USAGE'
Usage: install.sh --server https://hub.example.com [options]

Options:
  --server URL            Hub HTTPS origin (http:// is accepted only for loopback)
  --token-stdin           read the permanent node token from stdin
  --register-key KEY      exchange a short-lived registration key for a token
  --interval SECONDS      report interval, 3-60 (default 3)
  --iface LIST             traffic interfaces, comma separated; -name excludes one
  --root-prefix DIR       test mode: install under DIR, no users or systemd
  --no-start              stage files without starting the service
  --init SYSTEM          auto, systemd or openrc (default auto)
  --require-systemd       fail unless systemctl is available
  -h, --help              show this help
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

validate_server() {
    _raw=$1
    [ -n "$_raw" ] || die "server URL is empty"
    case "$_raw" in
        *[![:graph:]]*) die "server URL contains whitespace or control characters" ;;
    esac
    case "$_raw" in
        https://*) _scheme=https; _rest=${_raw#https://} ;;
        http://*) _scheme=http; _rest=${_raw#http://} ;;
        *) die "server URL must start with https://" ;;
    esac
    [ -n "$_rest" ] || die "server URL has no host"
    _authority=${_rest%%/*}
    _path=${_rest#"$_authority"}
    [ -n "$_authority" ] || die "server URL has no host"
    case "$_authority" in
        *@*) die "server URL must not contain userinfo" ;;
    esac
    case "$_authority" in
        *\?*|*#*) die "server URL must not contain a query or fragment" ;;
    esac
    case "$_path" in
        ""|"/") ;;
        *) die "server URL must not contain a path" ;;
    esac
    _host=$_authority
    case "$_host" in
        \[*\]*) _host=${_host#\[}; _host=${_host%%\]*} ;;
        *:*) _host=${_host%:*} ;;
    esac
    [ -n "$_host" ] || die "server URL has no host"
    case "$_scheme:$_host" in
        https:*) ;;
        http:127.0.0.1|http:localhost|http:::1) ;;
        *) die "plain HTTP is only allowed for loopback; use an HTTPS Hub origin" ;;
    esac
    SERVER=${_raw%/}
    SCHEME=$_scheme
}

curl_fetch() {
    _url=$1
    _out=$2
    if [ "$SCHEME" = https ]; then
        curl -fsSL --proto '=https' --proto-redir '=https' -o "$_out" "$_url"
    else
        curl -fsSL --proto '=http' --proto-redir '=http' -o "$_out" "$_url"
    fi
}

curl_register() {
    _out=$1
    _key=$2
    if [ "$SCHEME" = https ]; then
        curl -fsSL --proto '=https' --proto-redir '=https' -o "$_out" \
            --request POST \
            --header "Authorization: Bearer $_key" \
            --data-binary "$(hostname)" \
            "$SERVER/api/agent/register"
    else
        curl -fsSL --proto '=http' --proto-redir '=http' -o "$_out" \
            --request POST \
            --header "Authorization: Bearer $_key" \
            --data-binary "$(hostname)" \
            "$SERVER/api/agent/register"
    fi
}

# Read one string field from the compact JSON produced by the Hub.
json_string_field() {
    _file=$1
    _key=$2
    tr -d '\n' < "$_file" | sed -n 's/.*"'"$_key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

json_number_field() {
    _file=$1
    _key=$2
    tr -d '\n' < "$_file" | sed -n 's/.*"'"$_key"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n 1
}

write_unit() {
    _dst=$1
    if [ "$INIT_SYSTEM" = openrc ]; then
        cat > "$WORK/romi-agent.openrc.in" <<'OPENRC'
#!/sbin/openrc-run
description="romi monitoring Agent"
supervisor="supervise-daemon"
command="@ROMI_AGENT_BIN@"
command_user="romi-agent:romi-agent"
pidfile="/run/romi-agent.pid"
respawn_delay=5
respawn_max=0
retry="TERM/15/KILL/5"
output_log="/var/log/romi-agent.log"
error_log="/var/log/romi-agent.log"
umask=0077

depend() { need net; }
start_pre() {
    checkpath -f -m 0600 -o "$command_user" "$output_log" || return 1
    while IFS= read -r line; do
        case "$line" in
            ROMI_SERVER=*|ROMI_TOKEN=*|ROMI_INTERVAL=*|ROMI_IFACE=*) export "$line" ;;
        esac
    done < "@ROMI_AGENT_ENV@"
}
OPENRC
        sed -e "s|@ROMI_AGENT_BIN@|$OPT_CURRENT/romi-agent|g" \
            -e "s|@ROMI_AGENT_ENV@|$AGENT_ENV|g" \
            "$WORK/romi-agent.openrc.in" > "$_dst"
        return
    fi
    _unit_src=$SCRIPT_DIR/romi-agent.service.in
    if [ ! -r "$_unit_src" ]; then
        _unit_src=$WORK/romi-agent.service.in
        cat > "$_unit_src" <<'UNIT'
[Unit]
Description=romi Agent
Documentation=https://github.com/DejavuMoe/romi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=romi-agent
Group=romi-agent
UMask=0077
EnvironmentFile=@ROMI_AGENT_ENV@
ExecStart=@ROMI_AGENT_BIN@
Restart=always
RestartSec=5s
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK

[Install]
WantedBy=multi-user.target
UNIT
    fi
    sed -e "s|@ROMI_AGENT_BIN@|$OPT_CURRENT/romi-agent|g" \
        -e "s|@ROMI_AGENT_ENV@|$AGENT_ENV|g" \
        "$_unit_src" > "$_dst"
}

validate_iface() {
    _spec=$1
    [ -z "$_spec" ] && return 0
    _rest=$_spec
    while :; do
        case "$_rest" in
            *,*) _entry=${_rest%%,*}; _rest=${_rest#*,}; _more=1 ;;
            *) _entry=$_rest; _rest=; _more=0 ;;
        esac
        [ -n "$_entry" ] || die "--iface contains an empty interface name"
        case "$_entry" in
            -*) _name=${_entry#-} ;;
            *) _name=$_entry ;;
        esac
        [ -n "$_name" ] || die "--iface contains an empty interface name"
        case "$_name" in
            -*) die "--iface exclusions may have only one leading '-'" ;;
            *[!A-Za-z0-9_.:@+-]*) die "--iface contains unsupported interface-name characters" ;;
        esac
        [ "$_more" = 1 ] || break
    done
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --server)
            need_value "$@"; SERVER=$2; shift 2 ;;
        --token-stdin)
            TOKEN_MODE=token_stdin; shift ;;
        --register-key)
            need_value "$@"; REGISTER_KEY=$2; TOKEN_MODE=register_key; shift 2 ;;
        --interval)
            need_value "$@"; INTERVAL=$2; shift 2 ;;
        --iface)
            need_value "$@"; IFACE=$2; IFACE_SET=1; shift 2 ;;
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

[ -n "$SERVER" ] || die "--server is required (or set ROMI_SERVER)"
case "$INTERVAL" in
    ''|*[!0-9]*) die "--interval must be a number from 1 to 3600" ;;
esac
if [ "$INTERVAL" -ge 3 ] 2>/dev/null && [ "$INTERVAL" -le 60 ]; then
    :
else
    die "--interval must be 1-3600"
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

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/romi-agent-install.XXXXXX") || die "cannot create a temporary directory"
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

validate_server "$SERVER"

# Paths are all under ROOT_PREFIX in test mode, so a CI run cannot touch the
# real host. Production leaves ROOT_PREFIX empty.
OPT_ROOT="$ROOT_PREFIX/opt/romi"
OPT_RELEASES="$OPT_ROOT/releases"
OPT_CURRENT="$OPT_ROOT/current"
ETC_DIR="$ROOT_PREFIX/etc/romi"
AGENT_ENV="$ETC_DIR/agent.env"
UNIT_PATH="$ROOT_PREFIX/etc/systemd/system/romi-agent.service"
UNIT_MODE=0644
if [ "$INIT_SYSTEM" = openrc ]; then
    UNIT_PATH="$ROOT_PREFIX/etc/init.d/romi-agent"
    UNIT_MODE=0755
fi

# Preserve an existing interface policy across an ordinary reinstall/upgrade.
# Passing --iface explicitly, including an empty value, replaces it.
if [ "$IFACE_SET" = 0 ] && [ -r "$AGENT_ENV" ]; then
    IFACE=$(sed -n 's/^ROMI_IFACE=//p' "$AGENT_ENV" | head -n 1)
fi
validate_iface "$IFACE"

REQUEST_ARCH=$(uname -m)
case "$REQUEST_ARCH" in x86_64|aarch64) ;; *) die "unsupported host architecture: $REQUEST_ARCH" ;; esac
REQUEST_LIBC=gnu
if [ -e /etc/alpine-release ]; then REQUEST_LIBC=musl; fi
REQUEST_TARGET="$REQUEST_ARCH-unknown-linux-$REQUEST_LIBC"
curl_fetch "$SERVER/api/agent/distribution?target=$REQUEST_TARGET" "$WORK/distribution.json" \
    || die "cannot fetch the Hub Agent distribution metadata"

distribution_version=$(json_string_field "$WORK/distribution.json" version)
architecture=$(json_string_field "$WORK/distribution.json" architecture)
distribution_target=$(json_string_field "$WORK/distribution.json" target)
sha256=$(json_string_field "$WORK/distribution.json" sha256)
size=$(json_number_field "$WORK/distribution.json" size)
download=$(json_string_field "$WORK/distribution.json" download)
version=$distribution_version
case "$version" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "Hub advertises a malformed Agent version: $version" ;;
esac
OPT_VERSION="$OPT_RELEASES/$version"
[ "$architecture" = "$REQUEST_ARCH" ] || die "Hub advertises unsupported architecture: $architecture"
[ "$distribution_target" = "$REQUEST_TARGET" ] || die "Hub advertises unsupported target: $distribution_target"
case "$sha256" in
    ''|*[!0-9a-f]*) die "Hub distribution metadata carries an invalid SHA-256" ;;
esac
[ "${#sha256}" -eq 64 ] || die "Hub distribution metadata carries an invalid SHA-256"
case "$size" in
    ''|*[!0-9]*) die "Hub distribution metadata carries an invalid size" ;;
esac
[ "$download" = "/agent/v$version/$REQUEST_TARGET" ] || die "Hub distribution advertises an unexpected download path: $download"

curl_fetch "$SERVER$download" "$WORK/romi-agent" || die "cannot download the Agent binary"
actual_size=$(wc -c < "$WORK/romi-agent" | tr -d ' ')
[ "$actual_size" = "$size" ] || die "downloaded Agent has size $actual_size, expected $size"
actual_sha=$(sha256sum "$WORK/romi-agent" | cut -d' ' -f1)
[ "$actual_sha" = "$sha256" ] || die "downloaded Agent SHA-256 does not match Hub metadata"
chmod 0755 "$WORK/romi-agent"
reported=$("$WORK/romi-agent" --version 2>/dev/null) || die "downloaded Agent cannot execute"
[ "$reported" = "romi-agent $version" ] || die "downloaded Agent reports '$reported', expected 'romi-agent $version'"

case "$TOKEN_MODE" in
    register_key)
        [ -n "$REGISTER_KEY" ] || die "registration key is empty"
        case "$REGISTER_KEY" in
            *[!A-Za-z0-9._-]*) die "registration key contains unsupported characters" ;;
        esac
        curl_register "$WORK/register.response" "$REGISTER_KEY" \
            || die "registration key was refused or the Hub is unreachable"
        TOKEN=$(cat "$WORK/register.response")
        REGISTER_KEY=
        ;;
    token_stdin)
        IFS= read -r TOKEN || die "no token on stdin"
        ;;
    *)
        if [ -t 0 ]; then
            printf 'romi node token: ' >&2
            stty -echo 2>/dev/null || true
            IFS= read -r TOKEN || { stty echo 2>/dev/null || true; die "no token entered"; }
            stty echo 2>/dev/null || true
            printf '\n' >&2
        else
            die "no token supplied; use --token-stdin or --register-key"
        fi
        ;;
esac
[ -n "$TOKEN" ] || die "node token is empty"
case "$TOKEN" in
    ''|*[!A-Za-z0-9._-]*) die "node token contains unsupported characters" ;;
esac

# Install versioned files atomically. A failed download never reaches here, and
# an existing same-version directory is reused only if its binary is identical.
if [ -z "$ROOT_PREFIX" ]; then
    if grep -q "^$AGENT_GROUP:" /etc/group; then
        :
    else
        if command -v groupadd >/dev/null 2>&1; then groupadd --system "$AGENT_GROUP"
        else addgroup -S "$AGENT_GROUP"; fi
    fi
    if id -u "$AGENT_USER" >/dev/null 2>&1; then
        :
    else
        if command -v useradd >/dev/null 2>&1; then
            useradd --system --gid "$AGENT_GROUP" --home-dir /var/lib/romi-agent --no-create-home --shell /usr/sbin/nologin "$AGENT_USER"
        else
            adduser -S -D -H -G "$AGENT_GROUP" -h /var/lib/romi-agent -s /sbin/nologin "$AGENT_USER"
        fi
    fi
fi

install -d -m 0755 "$OPT_ROOT" "$OPT_RELEASES"
if [ -e "$OPT_VERSION" ]; then
    [ -x "$OPT_VERSION/romi-agent" ] || die "$OPT_VERSION exists but has no runnable Agent"
    installed_sha=$(sha256sum "$OPT_VERSION/romi-agent" | cut -d' ' -f1)
    [ "$installed_sha" = "$sha256" ] || die "$OPT_VERSION contains a different binary; refusing to replace it"
else
    stage="$OPT_RELEASES/.${version}.tmp.$$"
    [ ! -e "$stage" ] || die "temporary release path already exists: $stage"
    install -d -m 0755 "$stage"
    install -m 0755 "$WORK/romi-agent" "$stage/romi-agent"
    printf '%s\n' "$version" > "$WORK/VERSION"
    install -m 0644 "$WORK/VERSION" "$stage/VERSION"
    printf '{"format":1,"project":"romi","component":"agent","version":"%s","target":"%s","sha256":"%s","size":%s}\n' \
        "$version" "$REQUEST_TARGET" "$actual_sha" "$actual_size" > "$WORK/release.json"
    install -m 0644 "$WORK/release.json" "$stage/release.json"
    mv "$stage" "$OPT_VERSION" || { rm -rf "$stage"; die "cannot install $OPT_VERSION"; }
fi

install -d -m 0755 "$ETC_DIR"
env_tmp="$ETC_DIR/.agent.env.$$"
umask 077
{
    printf 'ROMI_SERVER=%s\n' "$SERVER"
    printf 'ROMI_TOKEN=%s\n' "$TOKEN"
    printf 'ROMI_INTERVAL=%s\n' "$INTERVAL"
    printf 'ROMI_IFACE=%s\n' "$IFACE"
} > "$env_tmp"
chmod 0600 "$env_tmp"
mv -f "$env_tmp" "$AGENT_ENV"
TOKEN=

unit_tmp="$WORK/romi-agent.service"
write_unit "$unit_tmp"
if [ -z "$ROOT_PREFIX" ] && [ "$INIT_SYSTEM" = systemd ] && command -v systemd-analyze >/dev/null 2>&1; then
    verify_unit="$WORK/romi-agent.verify.service"
    sed "s|$OPT_CURRENT/romi-agent|$OPT_VERSION/romi-agent|g" "$unit_tmp" > "$verify_unit"
    systemd_analyze_verify "$verify_unit" || die "generated Agent service unit failed systemd-analyze verify"
fi
install -d -m 0755 "$(dirname "$UNIT_PATH")"
unit_stage="$UNIT_PATH.$$"
[ ! -e "$unit_stage" ] || die "temporary unit path already exists: $unit_stage"
install -m "$UNIT_MODE" "$unit_tmp" "$unit_stage"
if [ -z "$ROOT_PREFIX" ]; then
    chown "root:root" "$unit_stage"
fi
mv -f "$unit_stage" "$UNIT_PATH"

# Stop the old process before the atomic switch; a failed new start leaves the
# previous version directory available for an explicit operator decision.
if [ -z "$ROOT_PREFIX" ] && [ "$START" = 1 ] && service_active; then
    service_stop
fi

# Atomic symlink switch: the previous release directory remains on disk.
link_tmp="$OPT_ROOT/.current.$$"
[ ! -e "$link_tmp" ] || rm -f "$link_tmp"
ln -s "releases/$version" "$link_tmp"
mv -Tf "$link_tmp" "$OPT_CURRENT" || die "cannot atomically switch $OPT_CURRENT"

if [ -n "$ROOT_PREFIX" ] || [ "$START" = 0 ]; then
    printf 'romi Agent %s staged at %s\n' "$version" "$OPT_VERSION"
    if [ "$START" = 0 ]; then
        printf 'service not started (--no-start or test mode)\n'
    fi
    exit 0
fi

service_start

attempt=0
while [ "$attempt" -lt 10 ]; do
    if service_active; then
        printf 'romi Agent %s is active\n' "$version"
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done
service_diagnostics
die "romi-agent did not become active; see the service status and journal above"
