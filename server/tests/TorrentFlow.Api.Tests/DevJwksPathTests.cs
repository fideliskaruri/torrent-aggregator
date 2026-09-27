using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;
using TorrentFlow.Api.RemoteAccess;

namespace TorrentFlow.Api.Tests;

public sealed class DevJwksPathTests
{
    [Fact]
    public async Task DevJwksPathIsIgnoredOutsideDevelopment()
    {
        var root = Path.Combine(Path.GetTempPath(), "tf-devjwks-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var jwksPath = Path.Combine(root, "dev-jwks.json");
            WriteJwks(jwksPath);

            var inner = new FakeKeySource();
            inner.Add(new SymmetricSecurityKey("not-used-but-present-0123456789ab"u8.ToArray()) { KeyId = "inner" });

            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [DevelopmentAwareAccessKeySource.DevJwksPathKey] = jwksPath,
                })
                .Build();

            var source = new DevelopmentAwareAccessKeySource(
                inner,
                new StubHostEnvironment(Environments.Production),
                config,
                NullLogger<DevelopmentAwareAccessKeySource>.Instance);

            var keys = await source.FetchSigningKeysAsync("sim", CancellationToken.None);

            Assert.Equal(1, inner.Fetches);
            Assert.Equal("inner", Assert.Single(keys).KeyId);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public async Task DevJwksPathIsUsedInDevelopment()
    {
        var root = Path.Combine(Path.GetTempPath(), "tf-devjwks-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var jwksPath = Path.Combine(root, "dev-jwks.json");
            WriteJwks(jwksPath, kid: "dev-file-key");

            var inner = new FakeKeySource();
            inner.Add(new SymmetricSecurityKey("not-used-but-present-0123456789ab"u8.ToArray()) { KeyId = "inner" });

            var config = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [DevelopmentAwareAccessKeySource.DevJwksPathKey] = jwksPath,
                })
                .Build();

            var source = new DevelopmentAwareAccessKeySource(
                inner,
                new StubHostEnvironment(Environments.Development),
                config,
                NullLogger<DevelopmentAwareAccessKeySource>.Instance);

            var keys = await source.FetchSigningKeysAsync("sim", CancellationToken.None);

            Assert.Equal(0, inner.Fetches);
            Assert.Equal("dev-file-key", Assert.Single(keys).KeyId);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch (IOException) { }
        }
    }

    [Fact]
    public async Task MissingDevJwksPathFallsThroughEvenInDevelopment()
    {
        var inner = new FakeKeySource();
        inner.Add(new SymmetricSecurityKey("not-used-but-present-0123456789ab"u8.ToArray()) { KeyId = "inner" });

        var config = new ConfigurationBuilder().AddInMemoryCollection().Build();
        var source = new DevelopmentAwareAccessKeySource(
            inner,
            new StubHostEnvironment(Environments.Development),
            config,
            NullLogger<DevelopmentAwareAccessKeySource>.Instance);

        var keys = await source.FetchSigningKeysAsync("sim", CancellationToken.None);
        Assert.Equal(1, inner.Fetches);
        Assert.Equal("inner", Assert.Single(keys).KeyId);
    }

    private static void WriteJwks(string path, string kid = "dev-file-key")
    {
        using var rsa = RSA.Create(2048);
        var jwk = JsonWebKeyConverter.ConvertFromRSASecurityKey(new RsaSecurityKey(rsa.ExportParameters(false)) { KeyId = kid });
        var json = JsonSerializer.Serialize(new
        {
            keys = new[]
            {
                new { kid = jwk.Kid, kty = "RSA", alg = "RS256", use = "sig", e = jwk.E, n = jwk.N },
            },
        });
        File.WriteAllText(path, json);
    }

    private sealed class StubHostEnvironment(string name) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = name;
        public string ApplicationName { get; set; } = "TorrentFlow.Tests";
        public string ContentRootPath { get; set; } = ".";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
