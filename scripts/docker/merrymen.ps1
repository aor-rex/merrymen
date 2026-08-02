# merrymen — Docker-mode CLI shim (Windows).
#
# Installed by install.ps1 when the user picks the Docker install. Translates
# the normal merrymen commands into docker runs against the locally-built
# image, mounting ~/.merrymen as the persistent data dir.
#
#   merrymen start        run the band as a detached daemon (dashboard:3100)
#   merrymen stop         stop the daemon
#   merrymen restart      restart the daemon
#   merrymen logs         tail the daemon's logs
#   merrymen update       rebuild the image from ~/.merrymen-docker/src
#   merrymen <anything>   one-shot run in a throwaway container (onboard,
#                         doctor, status, recover, kill, selftest, …)
#
# No --user flag here: on Docker Desktop / WSL2 a Windows host UID is
# meaningless and the gRPC-FUSE file sharing handles mount ownership itself.
param([Parameter(ValueFromRemainingArguments)] [string[]]$cmdArgs)

$ErrorActionPreference = "Stop"

$IMG = if ($env:MERRYMEN_IMAGE) { $env:MERRYMEN_IMAGE } else { "merrymen:latest" }
$CT = "merrymen"
$SRC = if ($env:MERRYMEN_DOCKER_SRC) { $env:MERRYMEN_DOCKER_SRC } else { Join-Path $HOME ".merrymen-docker\src" }
$VOL = if ($env:MERRYMEN_HOME) { $env:MERRYMEN_HOME } else { Join-Path $HOME ".merrymen" }

# The bind mount source must exist before docker starts, or docker makes it a
# root-owned directory.
New-Item -ItemType Directory -Force -Path $VOL | Out-Null

$mounts = @("-v", "$VOL`:/app/.merrymen", "-e", "MERRYMEN_HOME=/app/.merrymen")

function Say($msg) { Write-Host "  $msg" }

if ($cmdArgs.Count -eq 0) {
  Say "usage: merrymen <start|stop|restart|logs|update|onboard|doctor|status|...>"
  exit 1
}

switch ($cmdArgs[0]) {
  "start" {
    $exists = docker ps -a --format "{{.Names}}" | Select-String -Quiet "^$CT$"
    if ($exists) {
      $running = (docker inspect -f "{{.State.Running}}" $CT) -eq "true"
      if ($running) {
        Say "already riding (container '$CT') -- restart: merrymen restart | logs: merrymen logs"
        exit 0
      }
      docker start $CT | Out-Null
      Say "the band rides again (container '$CT') -- dashboard: http://localhost:3100"
      exit 0
    }
    docker run -d --name $CT --restart unless-stopped `
      -p 3100:3100 -e MERRYMEN_HOST=0.0.0.0 @mounts $IMG node cli/bin.mjs start --no-open
    Say "the band rides out (container '$CT') -- dashboard: http://localhost:3100"
    Say "logs: merrymen logs | stop: merrymen stop | doctor: merrymen doctor"
  }
  "stop" { docker stop $CT }
  "restart" { docker restart $CT }
  "logs" { docker logs -f $CT }
  "update" {
    if (-not (Test-Path $SRC)) {
      Say "no source checkout at $SRC -- re-run the installer to pick the Docker install."
      exit 1
    }
    & git -C $SRC pull --ff-only
    & docker build -t $IMG $SRC
    Say "image rebuilt. restart the daemon: merrymen restart"
  }
  default {
    # One-shot command. Attach a TTY only when stdin is one -- interactive
    # commands (onboard, recover) need it; piped commands must not choke on it.
    $tty = @("-t")
    if ([Console]::IsInputRedirected) { $tty = @() }
    & docker run --rm -i @tty @mounts $IMG node cli/bin.mjs $cmdArgs
  }
}
