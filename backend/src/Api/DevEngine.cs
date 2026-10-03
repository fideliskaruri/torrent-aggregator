using System.Collections.Immutable;
using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Nodes;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal static class DevEngine
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    internal static IServiceCollection AddDevEngine(this IServiceCollection services, string directory)
    {
        services.AddSingleton(sp => new MonoTorrentEngine(directory,
            message => sp.GetRequiredService<ILogger<MonoTorrentEngine>>().LogInformation("{EngineMessage}", message),
            maximumProbePieceBytes: sp.GetRequiredService<IConfiguration>()
                .GetValue("TorrentFlow:Engine:ProbeMaxPieceBytes", 32 * 1024 * 1024),
            probeDiskBudgetBytes: sp.GetRequiredService<IConfiguration>()
                .GetValue<long>("TorrentFlow:Engine:ProbeDiskBytes", 40L * 1024 * 1024)));
        services.AddSingleton<IEngine>(sp => sp.GetRequiredService<MonoTorrentEngine>());
        services.AddSingleton<DevDownloads>();
        services.AddHostedService<EngineHost>();
        return services;
    }

    internal static void MapDevEngine(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment()) return;
        app.MapDevDownloads();
        var group = app.MapGroup("/api/dev/engine").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var actor = AccessIdentity.Actor(http);
            if (actor.Role != UserRole.Owner || !actor.TrustedLocal ||
                http.Connection.RemoteIpAddress is not { } ip || !IPAddress.IsLoopback(ip))
                return Results.StatusCode(403);
            try { return await next(context); }
            catch (OperationCanceledException) when (!http.RequestAborted.IsCancellationRequested)
            { return Results.Json(new { error = "metadata_timeout", message = "No file list arrived. Check the network or try another torrent." }, statusCode: 408); }
            catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidDataException)
            { return Results.BadRequest(new { error = "invalid_input", message = ex.Message }); }
            catch (InvalidOperationException ex)
            { return Results.Conflict(new { error = "engine_conflict", message = ex.Message }); }
            catch (HttpRequestException)
            { return Results.Json(new { error = "metadata_unavailable", message = "Torrent metadata could not be downloaded. Check the connection or try another torrent." }, statusCode: 502); }
            catch (IOException ex)
            {
                http.RequestServices.GetRequiredService<ILogger<MonoTorrentEngine>>()
                    .LogWarning(ex, "Development engine file operation failed.");
                return Results.Conflict(new { error = "file_busy", message = "A download file could not be read or saved. Check the folder and try again." });
            }
        });
        group.MapGet("/torrents", async (MonoTorrentEngine engine, bool? pieces, CancellationToken ct) => Results.Json(new
        {
            listenPort = engine.ListenPort,
            physical = engine.PhysicalStatus,
            torrents = await engine.SnapshotAsync(ct),
            diagnostics = await engine.DiagnosticsAsync(ct, pieces == true),
        }, Json));
        group.MapPost("/probe", async (ProbeInput input, MonoTorrentEngine engine, CancellationToken ct) =>
        {
            if (input.Seconds is < 1 or > 60) return Results.BadRequest(new { error = "seconds must be 1..60" });
            var magnet = input.Magnet ?? input.Hash ?? throw new ArgumentException("Provide magnet or hash.");
            var attachment = input.Pieces
                ? await engine.AttachProbeAsync(input.TorrentUri is null ? Candidate(magnet) :
                    MonoTorrentEngine.CandidateFor(magnet, input.TorrentUri), ct)
                : await engine.AttachMetadataProbeAsync(Candidate(magnet), input.Trackerless, ct);
            if (attachment.Handle is not { } handle) return Results.Json(attachment, Json, statusCode: 409);
            var release = handle;
            var retained = false;
            try
            {
                if (input.Pieces)
                {
                    var evidence = await engine.ObserveProbeAsync(handle, TimeSpan.FromSeconds(input.Seconds), ct);
                    release = evidence.AdmissionHandle ?? handle;
                    retained = input.Retain && evidence.AdmissionHandle is not null;
                    return Results.Json(evidence with { AdmissionHandle = retained ? evidence.AdmissionHandle : null }, Json);
                }
                var measurement = await engine.ObserveMetadataProbeAsync(handle, TimeSpan.FromSeconds(input.Seconds), ct);
                var json = JsonSerializer.SerializeToNode(measurement.Evidence with { AdmissionHandle = null }, Json)!;
                json["protocolBytesDelivered"] = measurement.ProtocolBytesDelivered;
                json["trackerCount"] = measurement.TrackerCount;
                return Results.Json(json, Json);
            }
            finally { if (!retained) await engine.ReleaseProbeAsync(release, CancellationToken.None); }
        });
        group.MapPost("/add", async (AddInput input, MonoTorrentEngine engine, CancellationToken ct) =>
        {
            var hash = MonoTorrentEngine.NormalizeHash(input.Magnet);
            var existing = (await engine.SnapshotAsync(ct)).SingleOrDefault(s => s.Hash == hash);
            if (existing is not null) return Results.Json(new EngineResult(true, existing, null), Json);
            if (input.Files is null || input.Files.Length == 0 || input.Files.Any(i => i < 0) ||
                !Path.IsPathFullyQualified(input.SavePath))
                return Results.BadRequest(new { error = "Provide an absolute savePath and explicit file indices." });
            var candidate = Candidate(input.Magnet);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(30));
            var supplied = input.ProbeToken is null ? null : await engine.FindProbeAsync(input.ProbeToken, ct);
            if (input.ProbeToken is not null && supplied is null)
                return Results.Conflict(new { error = "The retained probe capability expired or was consumed." });
            var attachment = supplied is null ? await engine.AttachProbeAsync(candidate, deadline.Token) :
                new ProbeAttachment(supplied, null, null);
            if (attachment.Handle is not { } handle) return Results.Json(attachment, Json, statusCode: 409);
            var token = Guid.NewGuid().ToString("N");
            try
            {
                var files = await engine.WaitMetadataAsync(handle, deadline.Token);
                if (input.Files.Any(index => index >= files.Length))
                    return Results.BadRequest(new { error = "A selected file index is outside this torrent." });
                var root = Path.GetFullPath(input.SavePath);
                var bindings = files.Select(f =>
                {
                    var selected = input.Files.Contains(f.Index);
                    var path = Path.GetFullPath(Path.Combine(root, selected ? "" : $".unwanted\\{hash}\\{f.Index}", f.RelativePath));
                    if (!path.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new ArgumentException("Torrent file escapes the save path.");
                    RefuseLinks(path);
                    if (File.Exists(path + ".partial"))
                        throw new ArgumentException("The destination already contains a partial file. Choose a separate save path.");
                    return new FileBinding(f.Index, path + ".partial", selected);
                }).ToImmutableArray();
                var claim = await engine.ClaimAdmissionAsync(new(token, hash, hash, handle, DateTimeOffset.UtcNow.AddSeconds(90)), ct);
                if (!claim.Accepted) return Results.Json(claim, Json, statusCode: 409);
                var download = new DownloadRow(hash, hash, DownloadIntent.Run, null, DateTimeOffset.UtcNow,
                    null, token, null, null, 1);
                var result = await engine.AdmitFromProbeAsync(handle, new(download, candidate, bindings, token), ct);
                if (result.Accepted) await engine.SaveDevStateAsync(CancellationToken.None);
                return Results.Json(result, Json, statusCode: result.Accepted ? 200 : 409);
            }
            finally
            {
                await engine.ReleaseAdmissionClaimAsync(token, CancellationToken.None);
                await engine.ReleaseProbeAsync(handle, CancellationToken.None);
            }
        });
        group.MapDelete("/{hash}", async (string hash, bool? data, MonoTorrentEngine engine, CancellationToken ct) =>
        {
            var paths = await engine.RemoveDevAsync(MonoTorrentEngine.NormalizeHash(hash), ct);
            if (data == true)
                foreach (var path in paths)
                {
                    RefuseLinks(path);
                    File.Delete(path);
                }
            await engine.SaveDevStateAsync(CancellationToken.None);
            return Results.Json(new { removed = true, deletedFiles = data == true ? paths.Length : 0 });
        });
        group.MapPost("/{hash}/intent", async (string hash, IntentInput input, MonoTorrentEngine engine, CancellationToken ct) =>
        {
            var result = await engine.SetIntentAsync(MonoTorrentEngine.NormalizeHash(hash), input.Run, ct);
            await engine.SaveDevStateAsync(ct);
            return Results.Json(result, Json);
        });
        group.MapPost("/{hash}/recheck", async (string hash, MonoTorrentEngine engine, CancellationToken ct) =>
            Results.Json(await engine.RecheckAsync(MonoTorrentEngine.NormalizeHash(hash), ct), Json));
        group.MapPost("/shutdown", async (HttpContext http, IHostApplicationLifetime lifetime,
            MonoTorrentEngine engine, CancellationToken ct) =>
        {
            var diagnostics = await engine.DiagnosticsAsync(ct);
            http.Response.OnCompleted(() => { lifetime.StopApplication(); return Task.CompletedTask; });
            return Results.Json(new { stopping = true, diagnostics }, Json);
        });
    }

    private static Candidate Candidate(string magnet)
    {
        var xs = magnet.Split('&').FirstOrDefault(p => p.StartsWith("xs=", StringComparison.Ordinal));
        return MonoTorrentEngine.CandidateFor(magnet, xs is null ? null : Uri.UnescapeDataString(xs[3..]));
    }

    private static void RefuseLinks(string path)
    {
        for (var current = path; current is not null; current = Path.GetDirectoryName(current))
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new ArgumentException("Download paths cannot traverse links or junctions.");
    }

    private sealed record ProbeInput(string? Magnet, string? Hash, int Seconds = 20,
        bool Pieces = false, bool Retain = false, bool Trackerless = false, string? TorrentUri = null);
    private sealed record AddInput(string Magnet, int[] Files, string SavePath, string? ProbeToken = null);
    private sealed record IntentInput(bool Run);

    private sealed class EngineHost(MonoTorrentEngine engine, DevDownloads downloads, IServiceScopeFactory scopes,
        IHostEnvironment environment, ILogger<EngineHost> logger) : BackgroundService
    {
        private bool initialized;
        public override async Task StartAsync(CancellationToken ct)
        {
            await using var scope = scopes.CreateAsyncScope();
            var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("targets");
            var row = (await store.ReadAsync<SettingRow>(AccessState.Query("engine"), ct)).Single();
            await engine.InitializeAsync(SettingsCatalog.Read<EngineSettings>(row), async (port, token) =>
            {
                for (var attempt = 0; attempt < 3; attempt++)
                {
                    var old = (await store.ReadAsync<SettingRow>(AccessState.Query("engine"), token)).Single();
                    var value = SettingsCatalog.Read<EngineSettings>(old) with { ListenPort = port };
                    var next = old with { Value = JsonSerializer.SerializeToElement(value, Json),
                        Revision = old.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                    if ((await AccessState.CommitAsync(store, next, old.Revision, null, token)).Applied) return;
                }
                throw new InvalidOperationException("Engine listen port settings changed repeatedly. Restart to retry.");
            }, environment.IsDevelopment(), ct);
            if (environment.IsDevelopment()) await downloads.RecoverAsync(ct);
            initialized = true;
            await base.StartAsync(ct);
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            var ticks = 0;
            try
            {
                while (await timer.WaitForNextTickAsync(stoppingToken))
                    try
                    {
                        if (environment.IsDevelopment()) await downloads.TickAsync(stoppingToken);
                        if (++ticks % 20 == 0) await engine.TickAsync(environment.IsDevelopment(), stoppingToken);
                    }
                    catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
                    { logger.LogError(ex, "Engine tick failed; the next tick will retry."); }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        }

        public override async Task StopAsync(CancellationToken ct)
        {
            await base.StopAsync(ct);
            if (initialized && environment.IsDevelopment()) await engine.SaveDevStateAsync(CancellationToken.None);
            await engine.DisposeAsync();
        }
    }
}
