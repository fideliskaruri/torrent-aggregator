#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
printf '%s\n' 'TorrentFlow: http://127.0.0.1:5106 (available after the first build)'
exec dotnet run -c Release --project server/TorrentFlow.Api -- --urls http://127.0.0.1:5106
