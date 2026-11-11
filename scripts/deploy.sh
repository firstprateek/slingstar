#!/bin/sh
# Deploy Slingstar to this Mac for the iPhone (PLAN.md §9 Phase 5).
#
#   scripts/deploy.sh            build the precache, copy the shipped files to ~/apps/slingstar,
#                                (re)start the launch agent local.slingstar.server on
#                                127.0.0.1:8791 and expose it with Tailscale Serve on HTTPS port 10000.
#   scripts/deploy.sh --dry-run  print what it would do; change nothing.
#
# Never serve from ~/Documents: macOS blocks background services from reading it and the server
# hangs silently. Ports 443 and 8443 (Tailscale Serve) and local ports 8787, 8788 and 8790 belong to
# other apps; this script only touches HTTPS port 10000 and local port 8791.
set -eu

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${SLINGSTAR_DEST:-$HOME/apps/slingstar}"
LABEL="local.slingstar.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/slingstar-server.log"
PORT=8791
HTTPS_PORT=10000
NODE="$(command -v node || true)"
TAILSCALE="$(command -v tailscale || true)"
[ -z "$TAILSCALE" ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale

run() { if [ "$DRY" = 1 ]; then echo "would run: $*"; else "$@"; fi; }

[ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -n "$TAILSCALE" ] || { echo "tailscale CLI not found" >&2; exit 1; }
case "$DEST" in "$HOME/Documents"*) echo "refusing to deploy inside ~/Documents" >&2; exit 1;; esac

# 1. Precache list + version (so the service worker updates on the phone).
if [ "$DRY" = 1 ]; then echo "would run: node tools/build-precache.mjs"
else (cd "$SRC" && "$NODE" tools/build-precache.mjs); fi

# 2. Copy exactly the shipped files, plus the static server.
LIST="$(mktemp)"
trap 'rm -f "$LIST" "$LIST.have"' EXIT
(cd "$SRC" && "$NODE" --input-type=module -e "
  import { listShippedFiles } from './tools/build-precache.mjs';
  for (const f of listShippedFiles(process.cwd())) console.log(f);
  console.log('tools/serve.mjs');
") | sort > "$LIST"
echo "Shipping $(wc -l < "$LIST" | tr -d ' ') files to $DEST"
run mkdir -p "$DEST"
run rsync -a --files-from="$LIST" "$SRC/" "$DEST/"
# --files-from does not prune, so remove anything in $DEST that is no longer shipped.
if [ "$DRY" = 0 ]; then
  (cd "$DEST" && find . -type f | sed 's#^\./##' | sort) > "$LIST.have"
  comm -23 "$LIST.have" "$LIST" | while IFS= read -r f; do rm -f "$DEST/$f"; done
  find "$DEST" -type d -empty -delete
fi

# 3. Launch agent.
PLIST_BODY="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DEST/tools/serve.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>$PORT</string>
    <key>ROOT</key><string>$DEST</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>"
if [ "$DRY" = 1 ]; then echo "would write $PLIST:"; echo "$PLIST_BODY"
else mkdir -p "$(dirname "$PLIST")"; printf '%s\n' "$PLIST_BODY" > "$PLIST"; fi
run launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
run launchctl bootstrap "gui/$(id -u)" "$PLIST"

if [ "$DRY" = 0 ]; then
  up=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$PORT/index.html" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || { echo "Server did not answer on 127.0.0.1:$PORT. See $LOG" >&2; exit 1; }
  echo "Server is up on 127.0.0.1:$PORT."
fi

# 4. Tailscale Serve on HTTPS port 10000 only.
run "$TAILSCALE" serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$PORT"

HOSTNAME="$("$TAILSCALE" status --json 2>/dev/null | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{console.log("<this-mac>.<tailnet>.ts.net")}})')"
echo
echo "Open on the iPhone (Safari): https://$HOSTNAME:$HTTPS_PORT/"
echo "Then Share → Add to Home Screen."
