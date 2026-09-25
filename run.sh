#!/usr/bin/env sh
# Runs the .NET version. Pass a different address with: ./run.sh --urls http://127.0.0.1:3001
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$#" -eq 0 ]; then set -- --urls http://127.0.0.1:3000; fi
eval "last=\${$#}"
printf 'TorrentFlow: %s (first run builds the web UI)\n' "$last"
exec dotnet run -c Release --project server/TorrentFlow.Api -- "$@"
