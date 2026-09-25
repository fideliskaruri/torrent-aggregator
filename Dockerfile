# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS web
WORKDIR /src/web
RUN corepack enable && corepack prepare pnpm@12.4.2 --activate
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS publish
ARG TARGETARCH
WORKDIR /src
COPY Directory.Build.props Directory.Packages.props ./
COPY server/ server/
COPY --from=web /src/web/dist/ web/dist/
RUN dotnet publish server/TorrentFlow.Api -c Release -a $TARGETARCH \
    --self-contained false -p:UseAppHost=false -p:SkipWebBuild=true -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
# curl is deliberate: the base runtime has no HTTP health-probe command.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl gosu ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://0.0.0.0:3000 \
    TorrentFlow__DataDirectory=/data \
    TorrentFlow__DefaultDownloadDirectory=/media \
    TorrentFlow__Engine__ListenPort=6881 \
    DOTNET_RUNNING_IN_CONTAINER=true \
    PUID=1000 PGID=1000 TZ=Etc/UTC HOME=/data
COPY --from=publish /out/ ./
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/torrentflow-entrypoint
RUN mkdir -p /data /media
EXPOSE 3000 3940 6881/tcp 6881/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl --fail --silent --show-error --max-time 4 http://127.0.0.1:3000/api/health || exit 1
# Only initialization runs as root; the entrypoint execs the application as PUID:PGID.
ENTRYPOINT ["torrentflow-entrypoint"]
CMD ["dotnet", "TorrentFlow.dll"]
