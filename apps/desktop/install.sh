#!/usr/bin/env bash
# Puts the launcher's "desk (Electron)" on this machine (desk-electron.desktop), beside the native window's desk. Electron
# itself is copied to ~/.cache/desk/electron by this package's postinstall (fuses.ts), which pnpm install runs.
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
install -Dm644 "$here/desk-electron.desktop" ~/.local/share/applications/desk-electron.desktop
echo "desk (Electron) is in the launcher"
