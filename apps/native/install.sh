#!/usr/bin/env bash
# Puts desk's window on this machine, or again after a change to these files: the launcher's desk entry (desk.desktop)
# and the user service that keeps the window running hidden (desk-app.service), started again now. The window is
# built first if it never was; desk's server builds it again after each landing (apps/server/src/native.ts).
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
export CARGO_TARGET_DIR=~/.cache/desk/native-target
if [ ! -x "$CARGO_TARGET_DIR/release/desk" ]; then
	(cd "$here" && nice -n 19 ~/.cargo/bin/cargo build --release -j4)
fi
install -Dm644 "$here/desk.desktop" ~/.local/share/applications/desk.desktop
install -Dm644 "$here/desk-app.service" ~/.config/systemd/user/desk-app.service
systemctl --user daemon-reload
systemctl --user restart desk-app.service
echo "desk's window is installed and running hidden: the launcher's desk shows it (systemctl --user status desk-app)"
