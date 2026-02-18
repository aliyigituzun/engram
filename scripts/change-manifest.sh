#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/change-manifest.sh <firefox|chrome>"
  exit 1
fi

case "$1" in
  firefox)
    cp "${ROOT_DIR}/manifest.firefox.json" "${ROOT_DIR}/manifest.json"
    echo "manifest.json switched to Firefox profile (background.scripts)."
    ;;
  chrome)
    cp "${ROOT_DIR}/manifest.chrome.json" "${ROOT_DIR}/manifest.json"
    echo "manifest.json switched to Chrome profile (background.service_worker)."
    ;;
  *)
    echo "Unknown target: $1"
    echo "Usage: ./scripts/change-manifest.sh <firefox|chrome>"
    exit 1
    ;;
esac
