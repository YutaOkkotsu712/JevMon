#!/bin/sh
# Copies this directory to a server and (re)builds the container there. It is not a git repository, so this
# stands in for the README's clone step; rerun it to redeploy. The server builds its own image, because one
# built on this Mac is arm64 and most servers are not.
#
#   scripts/deploy-vps.sh user@host [remote-dir]
#
# With password login, ssh asks for the password once in this terminal: every step shares that connection.
set -eu
target=${1:?usage: scripts/deploy-vps.sh user@host [remote-dir]}
dir=${2:-jevmon}
case "$target" in -*) echo "not a host: $target" >&2; exit 1 ;; esac
# A plain folder name in the remote home only. The copy deletes whatever it does not recognise, so pointing it
# at "." or a path that already holds something else would wipe it.
case "$dir" in ''|.|..|*[!A-Za-z0-9._-]*) echo "remote-dir must be a plain folder name, like jevmon" >&2; exit 1 ;; esac
cd "$(dirname "$0")/.."
[ -f .env ] || { echo 'no .env here to deploy' >&2; exit 1; }

# The shared connection's socket lives in a private temporary folder, never at a guessable path another local
# user could claim first.
sockets=$(mktemp -d)
control="$sockets/ssh"
ssh_opts="-o ControlMaster=auto -o ControlPath=$control -o ControlPersist=120"
trap 'ssh -o ControlPath="$control" -O exit "$target" 2>/dev/null; rm -rf "$sockets"' EXIT
# shellcheck disable=SC2086 # the options are meant to split
remote() { ssh $ssh_opts "$target" "$@"; }

# Connect once, and check the server has what the rest needs. With password login, this is the only prompt.
remote "command -v rsync >/dev/null || { echo 'the server needs rsync (apt install rsync)' >&2; exit 1; }; \
  docker compose version >/dev/null 2>&1 || { echo 'the server needs Docker with the compose plugin, usable by this user' >&2; exit 1; }"

# Only an empty folder or an earlier deploy is ever overwritten.
remote "[ ! -e '$dir' ] || [ -z \"\$(ls -A '$dir')\" ] || [ -f '$dir/docker-compose.yml' ]" \
  || { echo "~/$dir on the server exists and is not a jevmon deploy; choose another remote-dir" >&2; exit 1; }
# Published ports bound to 127.0.0.1 are reachable from the rest of the local network on Docker before 28.
remote "docker version --format '{{.Server.Version}}'" | awk -F. '$1 < 28 { print "warning: Docker " $0 " on the server; upgrade to 28 or later so the loopback-only live view stays loopback-only" }'

# --delete keeps a file removed here from lingering there and being compiled into the image. Excluded paths
# are never deleted, so the server's battle logs, battle count and its own .env survive a redeploy.
rsync -az --delete -e "ssh $ssh_opts" --exclude node_modules --exclude dist --exclude /logs --exclude /.env \
  --exclude .DS_Store ./ "$target:$dir/"
# Sent on its own, owner-only: it holds the Showdown password and TYPESAFE_API_KEY.
remote "umask 077 && cat > '$dir/.env' && chmod 600 '$dir/.env'" < .env

# The container runs as uid 1000. On Linux a bind mount Docker has to create is owned by root, which the bot
# cannot write to: it would keep playing and silently stop recording decisions. So create it first, and prove
# the container can write to it before calling the deploy done.
remote "cd '$dir' && mkdir -p logs \
  && { [ \"\$(stat -c %u logs)\" = 1000 ] || chown 1000:1000 logs || { echo 'logs is not owned by uid 1000; chown it as root' >&2; exit 1; }; } \
  && { chmod 700 logs 2>/dev/null || true; } \
  && docker compose up -d --build \
  && docker compose exec -T jevmon sh -c 'touch logs/.probe && rm logs/.probe' \
  && docker compose ps"
