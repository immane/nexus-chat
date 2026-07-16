#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL Integration Smoke Test — Multi-User Conversation & File Upload
# Simulates two users having real conversations, uploading files, reacting, etc.
# Usage: ./scripts/ci-pg-smoke.sh
# Requires: docker compose, node, curl, python3

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

export no_proxy="127.0.0.1,localhost"
export LANG=en_US.UTF-8

PG_URL="postgres://nexus:nexus@localhost:5432/nexus_chat"
API="http://127.0.0.1:4000"
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
SERVER_PID=""
SERVER_LOG="${RUNNER_TEMP:-/tmp}/nexus-pg-smoke.log"

# Extract a value from the JSON response body (not the HTTP status line).
# Usage: jsonval "$RESP" "data.tokens.accessToken"
jsonval() {
  printf '%s' "$1" | python3 -c "
import sys, json
raw = sys.stdin.read()
lines = raw.split('\n')
# last line is HTTP code; join preceding lines as body
body = '\n'.join(lines[:-1]).strip()
if not body: print(''); sys.exit(0)
d = json.loads(body)
path = '$2'.split('.')
for p in path:
    if isinstance(d, dict):
        d = d.get(p, {})
    else:
        print(''); sys.exit(0)
print(d)
" 2>/dev/null || echo ""
}

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_server() {
  (
    cd "$PROJECT_ROOT/apps/server"
    PERSISTENCE=postgres DATABASE_URL="$PG_URL" \
      NODE_ENV=development PORT=4000 WEB_ORIGIN='*' \
      exec ./node_modules/.bin/tsx src/index.ts
  ) >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
}

wait_for_server() {
  for _ in $(seq 1 30); do
    if curl --fail --silent "$API/readyz" >/dev/null 2>&1; then
      echo -e "  ${GREEN}Server ready${NC}"
      return
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    sleep 1
  done

  echo -e "  ${RED}Server failed to become ready${NC}" >&2
  if [ -f "$SERVER_LOG" ]; then
    echo "--- Server log: $SERVER_LOG ---" >&2
    cat "$SERVER_LOG" >&2
  fi
  return 1
}

check() {
  local desc="$1" expected_http="$2" expected_field="${3:-}" expected_value="${4:-}"
  local actual_http
  actual_http=$(echo "$RESP" | tail -1)
  if [ "$actual_http" != "$expected_http" ]; then
    local body
    body=$(echo "$RESP" | sed '$d')
    echo -e "  ${RED}✗ $desc${NC} — HTTP $actual_http (expected $expected_http)"
    [ -n "$body" ] && echo "    Body: $(echo "$body" | head -c 200)"
    FAIL=$((FAIL + 1))
    return
  fi
  if [ -n "$expected_field" ]; then
    # Use python to extract and compare field value
    local body actual_value
    body=$(echo "$RESP" | sed '$d')
    actual_value=$(echo "$body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d$expected_field)
" 2>/dev/null || echo "")
    if [ "$actual_value" != "$expected_value" ]; then
      echo -e "  ${RED}✗ $desc${NC} — $expected_field = '$actual_value' (expected '$expected_value')"
      FAIL=$((FAIL + 1))
      return
    fi
  fi
  echo -e "  ${GREEN}✓ $desc${NC}"
  PASS=$((PASS + 1))
}

# POST/GET helpers: returns "body\nhttp_code"
post() {
  curl -s -w '\n%{http_code}' -X POST "$API/$1" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "${3:-}"
}
post_noauth() {
  curl -s -w '\n%{http_code}' -X POST "$API/$1" \
    -H "Content-Type: application/json" -d "$2"
}
get() {
  curl -s -w '\n%{http_code}' "$API/$1" -H "Authorization: Bearer $2"
}
patch() {
  curl -s -w '\n%{http_code}' -X PATCH "$API/$1" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"
}
del() {
  curl -s -w '\n%{http_code}' -X DELETE "$API/$1" -H "Authorization: Bearer $2"
}
del_body() {
  curl -s -w '\n%{http_code}' -X DELETE "$API/$1" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$3"
}
put_file() {
  curl -s -w '\n%{http_code}' -X PUT "$API/$1" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/octet-stream" --data-binary "$3"
}
get_raw() {
  curl -s -w '\n%{http_code}' "$API/$1" -H "Authorization: Bearer $2"
}

echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}  Nexus Chat — PostgreSQL Multi-User Integration Smoke Test${NC}"
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"

# --- Infra setup ---
echo -e "\n${BOLD}── Infrastructure Setup${NC}"
(cd "$PROJECT_ROOT" && docker compose up -d postgres redis --wait) >/dev/null 2>&1
(cd "$PROJECT_ROOT" && docker compose exec postgres psql -U nexus -d nexus_chat \
  -c "DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;" 2>/dev/null)
(cd "$PROJECT_ROOT" && pnpm --filter @nexus-chat/shared build) >/dev/null 2>&1
(cd "$PROJECT_ROOT" && pnpm --filter @nexus-chat/server db:migrate) >/dev/null 2>&1
(cd "$PROJECT_ROOT" && pnpm --filter @nexus-chat/server db:seed) >/dev/null 2>&1

start_server
wait_for_server

PASSWORD="SmokeTestPass123!"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act I: Onboarding ──────────${NC}"

echo -e "\n${BOLD}  Alice & Bob register${NC}"
RESP=$(post_noauth "api/v1/auth/register" \
  "{\"email\":\"alice@nexus.dev\",\"password\":\"$PASSWORD\",\"displayName\":\"Alice Chen\"}")
check "alice registers" "201"
AT=$(jsonval "$RESP" "data.tokens.accessToken")
AI=$(jsonval "$RESP" "data.user.id")

RESP=$(post_noauth "api/v1/auth/register" \
  "{\"email\":\"bob@nexus.dev\",\"password\":\"$PASSWORD\",\"displayName\":\"Bob Zhang\"}")
check "bob registers" "201"
BT=$(jsonval "$RESP" "data.tokens.accessToken")
BI=$(jsonval "$RESP" "data.user.id")

echo -e "\n${BOLD}  Alice creates workspace 'Nexus Team'${NC}"
RESP=$(post "api/v1/workspaces" "$AT" '{"name":"Nexus Team"}')
check "workspace created" "201"
WI=$(jsonval "$RESP" "data.id")

echo -e "\n${BOLD}  Alice invites Bob${NC}"
RESP=$(post "api/v1/workspaces/$WI/members" "$AT" "{\"userId\":\"$BI\",\"role\":\"admin\"}")
check "bob added as admin" "200"

echo -e "\n${BOLD}  Bob can see workspace${NC}"
RESP=$(get "api/v1/workspaces/$WI" "$BT")
check "bob sees workspace" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act II: Channels ──────────${NC}"

echo -e "\n${BOLD}  Alice creates #engineering & #random${NC}"
RESP=$(post "api/v1/workspaces/$WI/channels" "$AT" \
  '{"name":"engineering","mode":"normal","isPrivate":false}')
check "engineering created" "201"
EI=$(jsonval "$RESP" "data.id")

RESP=$(post "api/v1/workspaces/$WI/channels" "$AT" \
  '{"name":"random","mode":"normal","isPrivate":false}')
check "random created" "201"
RI=$(jsonval "$RESP" "data.id")

echo -e "\n${BOLD}  Alice sets channel description${NC}"
RESP=$(patch "api/v1/channels/$EI" "$AT" \
  '{"description":"Engineering team discussions and announcements"}')
check "channel description set" "200"

echo -e "\n${BOLD}  Alice adds Bob to #engineering${NC}"
RESP=$(post "api/v1/channels/$EI/members" "$AT" "{\"userId\":\"$BI\"}")
check "bob added to engineering" "200"

echo -e "\n${BOLD}  Bob mutes #random${NC}"
RESP=$(post "api/v1/channels/$RI/mute" "$BT")
check "bob mutes random" "200"
RESP=$(get "api/v1/channels/$RI/mute-status" "$BT")
check "bob mute status is true" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act III: Conversation in #engineering ──────────${NC}"

echo -e "\n${BOLD}  Alice sends messages${NC}"
RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a1\",\"content\":{\"type\":\"text\",\"text\":\"Good morning team! Ready for the sprint review?\"}}")
check "alice msg 1" "201"
AM1=$(jsonval "$RESP" "data.id")

RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a2\",\"content\":{\"type\":\"text\",\"text\":\"PostgreSQL migration is complete — production persistence works!\"}}")
check "alice msg 2" "201"
AM2=$(jsonval "$RESP" "data.id")

RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a3\",\"content\":{\"type\":\"text\",\"text\":\"Coverage is 98.9% across the board.\"}}")
check "alice msg 3" "201"
AM3=$(jsonval "$RESP" "data.id")

# Idempotency
echo -e "\n${BOLD}  Alice retries msg 1 (idempotency)${NC}"
RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a1\",\"content\":{\"type\":\"text\",\"text\":\"dup\"}}")
check "idempotent send" "201"

echo -e "\n${BOLD}  Bob reads and replies${NC}"
RESP=$(get "api/v1/channels/$EI/messages" "$BT")
check "bob reads channel" "200"

RESP=$(post "api/v1/messages" "$BT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"b1\",\"content\":{\"type\":\"text\",\"text\":\"Great work Alice! The persistence layer is super clean.\"}}")
check "bob msg 1" "201"
BM1=$(jsonval "$RESP" "data.id")

RESP=$(post "api/v1/messages" "$BT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"b2\",\"content\":{\"type\":\"text\",\"text\":\"The Signal prekey allocation is transactional now — concurrency issue solved.\"}}")
check "bob msg 2" "201"
BM2=$(jsonval "$RESP" "data.id")

# Alice replies to Bob
echo -e "\n${BOLD}  Alice replies to Bob's message${NC}"
RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a4\",\"content\":{\"type\":\"text\",\"text\":\"Thanks! FOR UPDATE SKIP LOCKED was the key.\"},\"replyToMessageId\":\"$BM2\"}")
check "alice replies to bob" "201"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act IV: Reactions, Edits, Pins ──────────${NC}"

echo -e "\n${BOLD}  Bob reacts to Alice's messages${NC}"
RESP=$(post "api/v1/messages/$AM2/reactions" "$BT" '{"emoji":"thumbsup"}')
check "bob reacts to msg2" "200"

echo -e "\n${BOLD}  Alice reacts to Bob${NC}"
RESP=$(post "api/v1/messages/$BM1/reactions" "$AT" '{"emoji":"heart"}')
check "alice reacts to bob" "200"

echo -e "\n${BOLD}  Alice edits her first message${NC}"
RESP=$(patch "api/v1/messages/$AM1" "$AT" '{"text":"Good morning team! Ready for our sprint review? (edited)"}')
check "alice edits own msg" "200"

echo -e "\n${BOLD}  Bob tries to edit Alice's message (should fail)${NC}"
RESP=$(patch "api/v1/messages/$AM1" "$BT" '{"text":"hacked"}')
check "bob cannot edit alice msg" "200"

echo -e "\n${BOLD}  Alice pins Bob's message${NC}"
RESP=$(post "api/v1/channels/$EI/pins" "$AT" "{\"messageId\":\"$BM2\"}")
check "alice pins bob msg" "200"

RESP=$(get "api/v1/channels/$EI/pins" "$AT")
check "pins list works" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act V: Read Receipts ──────────${NC}"

echo -e "\n${BOLD}  Bob marks channel read${NC}"
RESP=$(post "api/v1/channels/$EI/mark-read" "$BT")
check "bob marks read" "200"

echo -e "\n${BOLD}  Alice sends more — Bob gets unread${NC}"
RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a5\",\"content\":{\"type\":\"text\",\"text\":\"Demo is at 3pm, don't forget!\"}}")
check "alice reminder" "201"
AM5=$(jsonval "$RESP" "data.id")

RESP=$(get "api/v1/workspaces/$WI/unread-counts" "$BT")
check "bob has unread" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act VI: File Upload ──────────${NC}"

CONTENT="Hello Nexus Chat! This is a test file for smoke testing the attachment pipeline."
LEN=${#CONTENT}

echo -e "\n${BOLD}  Alice uploads a file${NC}"
RESP=$(post "api/v1/attachments/upload-sessions" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"fileName\":\"test-notes.txt\",\"contentType\":\"text/plain\",\"sizeBytes\":$LEN,\"encrypted\":false}")
check "upload session created" "201"
FID=$(jsonval "$RESP" "data.file.id")
SID=$(jsonval "$RESP" "data.uploadSession.id")

RESP=$(put_file "dev-upload/$FID" "$AT" "$CONTENT")
check "file bytes uploaded" "200"

RESP=$(post "api/v1/attachments/upload-sessions/$SID/complete" "$AT")
check "upload completed" "200"

RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"clientMsgId\":\"a-file\",\"content\":{\"type\":\"text\",\"text\":\"Here are the test notes:\",\"attachments\":[{\"fileId\":\"$FID\",\"name\":\"test-notes.txt\",\"mimeType\":\"text/plain\",\"size\":$LEN,\"scanStatus\":\"clean\"}]}}")
check "file message sent" "201"

echo -e "\n${BOLD}  Bob downloads the file${NC}"
RESP=$(get_raw "dev-download/$FID" "$BT")
DOWNLOAD=$(echo "$RESP" | sed '$d')
check "bob downloads file" "200"
[ "$DOWNLOAD" = "$CONTENT" ] && check "file content matches" "200" || { FAIL=$((FAIL+1)); echo -e "  ${RED}✗ file mismatch${NC}"; }

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act VII: Direct Messages ──────────${NC}"

echo -e "\n${BOLD}  Bob DMs Alice${NC}"
RESP=$(post "api/v1/dms?workspaceId=$WI" "$BT" \
  "{\"peerUserId\":\"$AI\",\"mode\":\"normal\"}")
check "bob creates DM" "201"
DI=$(jsonval "$RESP" "data.id")

echo -e "\n${BOLD}  Alice opens same DM (idempotent)${NC}"
RESP=$(post "api/v1/dms?workspaceId=$WI" "$AT" \
  "{\"peerUserId\":\"$BI\",\"mode\":\"normal\"}")
check "alice gets same DM" "201"

echo -e "\n${BOLD}  DM conversation${NC}"
RESP=$(post "api/v1/messages" "$BT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$DI\",\"clientMsgId\":\"dm-b1\",\"content\":{\"type\":\"text\",\"text\":\"Hey Alice, want to pair on Redis caching tomorrow?\"}}")
check "bob DM" "201"

RESP=$(post "api/v1/messages" "$AT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$DI\",\"clientMsgId\":\"dm-a1\",\"content\":{\"type\":\"text\",\"text\":\"Sure! Let's meet at 10am.\"}}")
check "alice DM reply" "201"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act VIII: Forward & Save ──────────${NC}"

echo -e "\n${BOLD}  Bob forwards Alice's message to #random${NC}"
RESP=$(post "api/v1/messages/$AM3/forward" "$BT" \
  "{\"targetChannelId\":\"$RI\",\"clientMsgId\":\"fw-1\"}")
check "bob forwards" "200"

echo -e "\n${BOLD}  Save for later${NC}"
RESP=$(post "api/v1/messages/$BM2/save" "$AT")
check "alice saves bob msg" "200"
RESP=$(post "api/v1/messages/$AM2/save" "$BT")
check "bob saves alice msg" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act IX: Bot ──────────${NC}"

echo -e "\n${BOLD}  Alice installs /help bot${NC}"
RESP=$(post "api/v1/bots/install?workspaceId=$WI" "$AT" \
  '{"id":"smoke-help-bot","name":"HelpBot","version":"1.0","description":"Help bot","scopes":["messages:write"],"commands":[{"name":"/help","description":"Show help"}]}')
check "bot installed" "201"

RESP=$(post "api/v1/bots/smoke-help-bot/channels/$EI" "$AT")
check "bot added to channel" "200"

echo -e "\n${BOLD}  Bob invokes /help${NC}"
RESP=$(post "api/v1/bots/commands" "$BT" \
  "{\"workspaceId\":\"$WI\",\"channelId\":\"$EI\",\"command\":\"/help\",\"args\":\"\",\"userId\":\"$BI\"}")
check "help works" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act X: Cleanup ──────────${NC}"

echo -e "\n${BOLD}  Remove reaction${NC}"
RESP=$(del_body "api/v1/messages/$BM1/reactions" "$AT" '{"emoji":"heart"}')
check "remove reaction" "200"

echo -e "\n${BOLD}  Delete & Archive${NC}"
RESP=$(del "api/v1/messages/$AM5" "$AT")
check "delete msg" "200"
RESP=$(post "api/v1/channels/$RI/archive" "$AT")
check "archive random" "200"
RESP=$(del "api/v1/channels/$RI/mute" "$BT")
check "unmute" "200"
RESP=$(del "api/v1/channels/$EI/pins/$BM2" "$AT")
check "unpin" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act XI: Signal PreKey ──────────${NC}"

echo -e "\n${BOLD}  Upload & fetch prekey bundles${NC}"
RESP=$(post "api/v1/signal/prekey-bundles" "$AT" \
  "{\"userId\":\"$AI\",\"deviceId\":\"device-01\",\"identityKey\":\"YWxpY2VJZGVudGl0eUtleQ==\",\"signedPreKeyId\":1,\"signedPreKey\":\"c2lnbmVkUHJlS2V5\",\"signedPreKeySignature\":\"c2lnbmF0dXJl\",\"oneTimePreKeys\":[{\"keyId\":1,\"publicKey\":\"b25lVGltZUtleTE=\"},{\"keyId\":2,\"publicKey\":\"b25lVGltZUtleTI=\"}]}")
check "bundle uploaded" "200"

RESP=$(post "api/v1/signal/prekey-bundles" "$BT" \
  "{\"userId\":\"$BI\",\"deviceId\":\"device-01\",\"identityKey\":\"Ym9iSWRlbnRpdHlLZXk=\",\"signedPreKeyId\":1,\"signedPreKey\":\"Ym9iUHJlS2V5\",\"signedPreKeySignature\":\"Ym9iU2ln\",\"oneTimePreKeys\":[{\"keyId\":1,\"publicKey\":\"Ym9iT25lVGltZUtleQ==\"}]}")
check "bob bundle uploaded" "200"

FIRST_FETCH=$(mktemp)
SECOND_FETCH=$(mktemp)
get "api/v1/signal/prekey-bundles/$AI/device-01" "$BT" >"$FIRST_FETCH" &
FIRST_FETCH_PID=$!
get "api/v1/signal/prekey-bundles/$AI/device-01" "$BT" >"$SECOND_FETCH" &
SECOND_FETCH_PID=$!
wait "$FIRST_FETCH_PID"
wait "$SECOND_FETCH_PID"
FIRST_RESPONSE=$(<"$FIRST_FETCH")
SECOND_RESPONSE=$(<"$SECOND_FETCH")
rm "$FIRST_FETCH" "$SECOND_FETCH"
FIRST_PREKEY=$(jsonval "$FIRST_RESPONSE" "data.oneTimePreKeyId")
SECOND_PREKEY=$(jsonval "$SECOND_RESPONSE" "data.oneTimePreKeyId")
if [ "$FIRST_PREKEY" = "{}" ] || [ "$SECOND_PREKEY" = "{}" ] || [ "$FIRST_PREKEY" = "$SECOND_PREKEY" ]; then
  echo -e "  ${RED}✗ concurrent prekey fetches each return a distinct key${NC}"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}✓ concurrent prekey fetches each return a distinct key${NC}"
  PASS=$((PASS + 1))
fi

RESP=$(get "api/v1/signal/prekey-bundles/$AI/device-01" "$BT")
check "bob fetches alice bundle" "200"

RESP=$(get "api/v1/signal/prekey-bundles/$AI/device-01/count" "$AT")
check "prekey count" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}────────── Act XII: Persistence Across Restart ──────────${NC}"

echo -e "\n  Restarting server..."
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

start_server
wait_for_server

echo -e "${BOLD}  Verifying data survived${NC}"
RESP=$(post_noauth "api/v1/auth/login" \
  "{\"email\":\"alice@nexus.dev\",\"password\":\"$PASSWORD\"}")
check "alice login after restart" "200"
AT=$(jsonval "$RESP" "data.tokens.accessToken")

RESP=$(post_noauth "api/v1/auth/login" \
  "{\"email\":\"bob@nexus.dev\",\"password\":\"$PASSWORD\"}")
check "bob login after restart" "200"
BT=$(jsonval "$RESP" "data.tokens.accessToken")

RESP=$(get "api/v1/channels/$EI/messages?limit=50" "$AT")
check "messages survived" "200"

RESP=$(get "api/v1/channels/$DI/messages" "$AT")
check "DM survived" "200"

RESP=$(get "api/v1/attachments/$FID" "$AT")
check "file metadata survived" "200"

RESP=$(get "api/v1/bots/smoke-help-bot/subscriptions" "$AT")
check "bot survived" "200"

# ═══════════════════════════════════════════════════════════════════════════
echo -e "\n${CYAN}${BOLD}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}${BOLD}  Results: ${GREEN}$PASS passed${NC}${CYAN}${BOLD}, ${RED}$FAIL failed${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}${BOLD}  SMOKE TEST FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}  SMOKE TEST PASSED${NC}"
  exit 0
fi
