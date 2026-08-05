#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <output-tarball-path>" >&2
  exit 1
fi

OUT_PATH="$1"
REPO="${REPO:-alexcheng-dev/9router}"
WORKFLOW="${WORKFLOW:-build-standalone.yml}"
ARTIFACT_NAME="${ARTIFACT_NAME:-9router-standalone}"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "unzip is required" >&2; exit 1; }

RUN_ID="$(gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW" \
  --branch master \
  --status completed \
  --limit 20 \
  --json databaseId,conclusion \
  --jq '.[] | select(.conclusion=="success") | .databaseId' | head -n 1)"

if [[ -z "${RUN_ID:-}" ]]; then
  echo "No successful $WORKFLOW runs found for $REPO" >&2
  exit 1
fi

ARTIFACT_ID="$(gh api "repos/$REPO/actions/runs/$RUN_ID/artifacts" --jq ".artifacts[]? | select(.name==\"$ARTIFACT_NAME\" and .expired==false) | .id" | head -n 1)"

if [[ -z "${ARTIFACT_ID:-}" ]]; then
  echo "Artifact $ARTIFACT_NAME not found for run $RUN_ID in $REPO" >&2
  exit 1
fi

ZIP_PATH="$TMP_DIR/artifact.zip"
gh api "repos/$REPO/actions/artifacts/$ARTIFACT_ID/zip" > "$ZIP_PATH"
unzip -qo "$ZIP_PATH" -d "$TMP_DIR/out"

TARBALL="$(find "$TMP_DIR/out" -type f -name '*.tgz' | head -n 1)"
if [[ -z "${TARBALL:-}" ]]; then
  echo "No .tgz found inside artifact $ARTIFACT_NAME" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"
cp "$TARBALL" "$OUT_PATH"
echo "$OUT_PATH"
