#!/usr/bin/env bash
# merrymen installer for macOS/Linux — local (Node) or Docker, your choice.
#
#   curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash
#
# Asks how you'd like to run merrymen:
#   1) Local machine — installs Node (if needed) + merrymen via npm.
#   2) Docker       — clones the source, builds the image locally (no registry),
#                     installs a `merrymen` wrapper that drives docker.
#
# Safe to re-run. Installs Node only via a package manager you already have
# (Homebrew / fnm); otherwise it points you to nodejs.org rather than guessing.
set -euo pipefail

grn() { printf "  \033[32m%s\033[0m\n" "$1"; }
ylw() { printf "  \033[33m%s\033[0m\n" "$1"; }
red() { printf "  \033[31m%s\033[0m\n" "$1"; }
dim() { printf "  \033[2m%s\033[0m\n" "$1"; }

echo
grn "merrymen -- stand and deliver"
dim "setting up your rig..."
echo

RERUN="curl -fsSL https://raw.githubusercontent.com/millw14/merrymen/main/install.sh | bash"
DOCKER_SRC="$HOME/.merrymen-docker/src"
DOCKER_BIN="$HOME/.local/bin"

# ── pick the install method ──────────────────────────────────────────────
# A piped script (`curl | bash`) has its stdin stolen by the pipe, so read the
# answer from the controlling terminal directly. No TTY (or a non-interactive
# run) falls back to the local install.
echo
grn "How would you like to run merrymen?"
dim "  1) Local machine  (Node 22.12+ + npm install -g)"
dim "  2) Docker         (build the image locally, no registry)"
choice=""
while [ -z "$choice" ]; do
  printf "  choice [1/2]: "
  if ! read -r choice < /dev/tty; then
    choice=1 # no TTY — fall back to the local install
    break
  fi
  case "$choice" in
    1|2) ;;
    *) ylw "  pick 1 or 2."; choice="" ;;
  esac
done

if [ "$choice" = "2" ]; then
  echo
  grn "[ok] Docker install"

  if ! command -v docker >/dev/null 2>&1; then
    red "Docker isn't installed."
    dim "  macOS:  https://docs.docker.com/desktop/setup/install/mac-install/"
    dim "  Linux:  your package manager, or https://docs.docker.com/engine/install/"
    dim "Then re-run:  $RERUN"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    red "Docker is installed but the daemon isn't running."
    dim "Start Docker Desktop (or the docker service), then re-run:  $RERUN"
    exit 1
  fi

  # Get the source for the image build. Prefer git (keeps `merrymen update` a
  # fast pull); fall back to the main-branch tarball when git is missing.
  if [ -d "$DOCKER_SRC/.git" ]; then
    ylw "[..] refreshing the merrymen source..."
    git -C "$DOCKER_SRC" pull --ff-only
  elif command -v git >/dev/null 2>&1; then
    ylw "[..] cloning the merrymen source for the image build..."
    mkdir -p "$(dirname "$DOCKER_SRC")"
    git clone --depth 1 https://github.com/millw14/merrymen.git "$DOCKER_SRC"
  else
    ylw "[..] no git found — downloading the merrymen source tarball instead..."
    TMP_DIR="$(mktemp -d)"
    curl -fsSL https://codeload.github.com/millw14/merrymen/tar.gz/refs/heads/main -o "$TMP_DIR/merrymen.tar.gz"
    tar -xzf "$TMP_DIR/merrymen.tar.gz" -C "$TMP_DIR"
    rm -rf "$DOCKER_SRC" 2>/dev/null || true
    mkdir -p "$(dirname "$DOCKER_SRC")"
    mv "$TMP_DIR/merrymen-main" "$DOCKER_SRC"
    rm -rf "$TMP_DIR"
  fi

  ylw "[..] building the image (first build installs deps + builds the dashboard — a few minutes)..."
  docker build -t merrymen:latest "$DOCKER_SRC"

  ylw "[..] installing the 'merrymen' wrapper..."
  mkdir -p "$DOCKER_BIN"
  install -m 755 "$DOCKER_SRC/scripts/docker/merrymen" "$DOCKER_BIN/merrymen"

  # ── make the dashboard reachable ──────────────────────────────────────
  # The point of the Docker install is a server. The dashboard's host guard only
  # lets loopback + private IPs through, so on a VPS (a public primary IP) every
  # /api/* call is 403 unless that IP is allowlisted — persist it to the wrapper's
  # env file so it survives shells + reboots. On a private-LAN box (laptop) the
  # LAN IP already passes; the detected public IP is still allowlisted as a no-op
  # (it also covers NAT'd cloud VPSes with a private NIC IP).
  primary_ip() {
    local ip=""
    if command -v hostname >/dev/null 2>&1; then
      ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
      ip="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2; exit}' | cut -d/ -f1)"
    fi
    printf '%s' "$ip"
  }
  CFG="$HOME/.merrymen-docker/env"
  PRIMARY_IP="$(primary_ip)"
  case "$PRIMARY_IP" in
    ""|127.*|10.*|192.168.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*|*:*) LAN=1 ;;
    *) LAN=0 ;;
  esac
  SERVER_IP=""
  if [ "$LAN" = "0" ]; then
    SERVER_IP="$PRIMARY_IP"
  elif command -v curl >/dev/null 2>&1; then
    ylw "[..] detecting the public IP (dashboard host guard)..."
    SERVER_IP="$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  fi
  if [ -n "$SERVER_IP" ]; then
    mkdir -p "$(dirname "$CFG")"
    printf 'MERRYMEN_ALLOWED_HOSTS=%s\n' "$SERVER_IP" > "$CFG"
    grn "[ok] dashboard host $SERVER_IP allowlisted"
  else
    rm -f "$CFG"
  fi

  # Open the dashboard port when ufw is around (root: do it, else nudge).
  if command -v ufw >/dev/null 2>&1; then
    if [ "$(id -u)" = "0" ]; then
      ufw allow 3100/tcp >/dev/null 2>&1 && grn "[ok] ufw: port 3100/tcp opened"
    else
      ylw "Open the dashboard port so it's reachable (and 3100/tcp in your cloud firewall):"
      dim "  sudo ufw allow 3100/tcp"
      echo
    fi
  fi

  # Start the band now — dashboard + worker — so the installer is done.
  ylw "[..] starting the band (dashboard + worker in Docker)..."
  "$DOCKER_BIN/merrymen" start

  # nudge about PATH if ~/.local/bin isn't on it (the "command not found" trap)
  if ! printf ':%s:' "$PATH" | grep -q ":$DOCKER_BIN:"; then
    ylw "Add ~/.local/bin to your PATH (then reopen your shell):"
    dim "  echo 'export PATH=\"$DOCKER_BIN:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    echo
  fi

  # If ~/.merrymen already exists but is owned by root (an earlier Docker run
  # without user mapping), the unprivileged container user can't write to it.
  if [ -d "$HOME/.merrymen" ] && ! [ -O "$HOME/.merrymen" ]; then
    ylw "~/.merrymen isn't owned by you — the container writes as your user. Fix once:"
    dim "  sudo chown -R \"$(id -u):$(id -g)\" \"$HOME/.merrymen\""
    echo
  fi

  echo
  if [ "$LAN" = "0" ]; then
    grn "the band is live — dashboard: http://$SERVER_IP:3100"
  else
    grn "the band is live — dashboard: http://localhost:3100 (LAN: http://$PRIMARY_IP:3100)"
    if [ -n "$SERVER_IP" ]; then
      dim "  a NAT'd server is also reachable via: http://$SERVER_IP:3100"
    fi
  fi
  dim "  add your keys, strategy + basket at /settings (or: merrymen onboard)"
  dim "  doctor: merrymen doctor · logs: merrymen logs · stop: merrymen stop"
  echo
  exit 0
fi

# ── local install ────────────────────────────────────────────────────────
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj rest min
  v=$(node -v | sed 's/^v//')
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}
  [ "$maj" -gt 22 ] || { [ "$maj" -eq 22 ] && [ "$min" -ge 12 ]; }
}

if node_ok; then
  grn "[ok] node $(node -v) already installed"
else
  ylw "[..] Node 22.12+ not found -- installing..."
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v fnm >/dev/null 2>&1; then
    fnm install 22 && fnm use 22
  else
    red "No Homebrew or fnm found to install Node automatically."
    dim "Install Node 22.12+ from https://nodejs.org/en/download (or via nvm), then re-run:"
    dim "  $RERUN"
    exit 1
  fi
  if ! node_ok; then
    red "Node installed but this shell still sees an old/none version."
    dim "Open a new terminal (or 'fnm use 22'), then re-run:  $RERUN"
    exit 1
  fi
  grn "[ok] node $(node -v) installed"
fi

ylw "[..] installing merrymen (global)..."
npm install -g merrymen

echo
grn "the band is ready. next:"
dim "  merrymen setup     # confirm the rig"
dim "  merrymen onboard   # keys, strategy, basket"
dim "  merrymen start     # dashboard at localhost:3100 + the worker"
echo

# nudge about PATH if npm's global bin isn't on it (the "command not found" trap)
prefix=$(npm prefix -g 2>/dev/null || true)
if [ -n "$prefix" ] && ! printf ':%s:' "$PATH" | grep -q ":$prefix/bin:"; then
  ylw "Add npm's global bin to PATH (then reopen your shell):"
  dim "  echo 'export PATH=\"$prefix/bin:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
  echo
fi
