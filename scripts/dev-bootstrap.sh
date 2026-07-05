#!/usr/bin/env bash
# dev-bootstrap.sh - bootstrap in-memory dev data via REST API.
# Phase 1 uses in-memory stores, so this script seeds via HTTP instead of DB.
# Usage: bash scripts/dev-bootstrap.sh [API_BASE]
set -euo pipefail

API="${1:-http://127.0.0.1:4000}"
PASSWORD="${NEXUS_DEV_PASSWORD:-test1234abcd}"

log()  { printf '[dev-bootstrap] %s\n' "$*"; }
fail() { printf '[dev-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

curl_clean() {
  http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= all_proxy= ALL_PROXY= no_proxy= NO_PROXY= curl -sS "$@"
}

extract_string() {
  local key="$1"
  sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

api() {
  local method="$1" path="$2" token="${3:-}" body="${4:-}"
  local response status payload

  if [ -n "$token" ] && [ -n "$body" ]; then
    response=$(curl_clean -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $token" -H "Content-Type: application/json" -d "$body")
  elif [ -n "$token" ]; then
    response=$(curl_clean -w '\n%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $token")
  elif [ -n "$body" ]; then
    response=$(curl_clean -w '\n%{http_code}' -X "$method" "$API$path" -H "Content-Type: application/json" -d "$body")
  else
    response=$(curl_clean -w '\n%{http_code}' -X "$method" "$API$path")
  fi
  status="${response##*$'\n'}"
  payload="${response%$'\n'*}"

  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    printf '%s\n' "$payload" >&2
    return 1
  fi

  if ! printf '%s' "$payload" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    printf '%s\n' "$payload" >&2
    return 1
  fi

  printf '%s\n' "$payload"
}

register_user() {
  local email="$1" name="$2"
  local body payload
  body='{"email":"'"$email"'","password":"'"$PASSWORD"'","displayName":"'"$name"'"}'

  if payload=$(api POST /api/v1/auth/register "" "$body" 2>&1); then
    return 0
  fi

  if printf '%s' "$payload" | grep -q '"code"[[:space:]]*:[[:space:]]*"CONFLICT"'; then
    return 0
  fi

  printf '%s\n' "$payload" >&2
  return 1
}

login_user() {
  local email="$1"
  api POST /api/v1/auth/login "" '{"email":"'"$email"'","password":"'"$PASSWORD"'"}'
}

check_server() {
  curl_clean -f "$API/healthz" >/dev/null 2>&1 || fail "Server not reachable at $API"
}

check_server

log "registering alice ..."
register_user "alice@dev.local" "Alice"

log "registering bob ..."
register_user "bob@dev.local" "Bob"

log "logging in as alice ..."
ALICE_LOGIN=$(login_user "alice@dev.local")
ALICE_TOKEN=$(printf '%s' "$ALICE_LOGIN" | extract_string accessToken)
ALICE_ID=$(printf '%s' "$ALICE_LOGIN" | extract_string id)
[ -n "$ALICE_TOKEN" ] || fail "Unable to extract alice access token"
[ -n "$ALICE_ID" ] || fail "Unable to extract alice user id"
log "  alice id = $ALICE_ID"

log "logging in as bob ..."
BOB_LOGIN=$(login_user "bob@dev.local")
BOB_ID=$(printf '%s' "$BOB_LOGIN" | extract_string id)
[ -n "$BOB_ID" ] || fail "Unable to extract bob user id"
log "  bob id   = $BOB_ID"

log "creating workspace ..."
WORKSPACE=$(api POST /api/v1/workspaces "$ALICE_TOKEN" '{"name":"Dev Workspace"}')
WS_ID=$(printf '%s' "$WORKSPACE" | extract_string id)
[ -n "$WS_ID" ] || fail "Unable to extract workspace id"
log "  workspace = $WS_ID"

log "looking up default channel ..."
CHANNELS=$(api GET "/api/v1/workspaces/$WS_ID/channels" "$ALICE_TOKEN")
CH_ID=$(printf '%s' "$CHANNELS" | extract_string id)
[ -n "$CH_ID" ] || fail "Unable to extract default channel id"
log "  channel   = $CH_ID"

log "adding bob to workspace ..."
api POST "/api/v1/workspaces/$WS_ID/members" "$ALICE_TOKEN" '{"userId":"'"$BOB_ID"'","role":"member"}' >/dev/null

log "adding bob to #general ..."
api POST "/api/v1/channels/$CH_ID/members" "$ALICE_TOKEN" '{"userId":"'"$BOB_ID"'"}' >/dev/null

log ""
log "dev bootstrap done."
log "  API       : $API"
log "  alice     : alice@dev.local / $PASSWORD  (id=$ALICE_ID)"
log "  bob       : bob@dev.local   / $PASSWORD  (id=$BOB_ID)"
log "  workspace : $WS_ID"
log "  channel   : $CH_ID"
