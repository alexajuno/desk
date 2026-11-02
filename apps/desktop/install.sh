#!/usr/bin/env bash
# Puts desk's app on this machine, or again after a change to these files: the launcher's desk entry (desk.desktop) and
# the user service that keeps the app running (desk-app.service), started now, which closes any tabs Claude had open.
# Hyprland starts the service at each login.
set -euo pipefail
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
install -Dm644 "$here/desk.desktop" ~/.local/share/applications/desk.desktop
install -Dm644 "$here/desk-app.service" ~/.config/systemd/user/desk-app.service
systemctl --user daemon-reload
systemctl --user restart desk-app.service
echo "desk's app is installed and running: systemctl --user status desk-app"
