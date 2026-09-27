using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Storage;
using System.Security.AccessControl;
using System.Security.Principal;

namespace TorrentFlow.Engine.Tests;

public class DownloadDirectoryTests
{
    [Fact]
    public async Task ExistingReadOnlyDirectoryIsRejectedWithoutPersistingATransfer()
    {
        if (!OperatingSystem.IsWindows()) return;
        await using var h = await EngineHarness.CreateAsync();
        var directory = Directory.CreateDirectory(Path.Combine(h.Root, "read-only"));
        var original = directory.GetAccessControl();
        var denied = directory.GetAccessControl();
        denied.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!,
            FileSystemRights.WriteData | FileSystemRights.AppendData, AccessControlType.Deny));
        try
        {
            directory.SetAccessControl(denied);
            // mkdir on an existing directory succeeds, so it alone is not an admission check.
            Directory.CreateDirectory(directory.FullName);
            var result = await h.Engine.AddAsync(new()
            {
                Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Keep, SavePath = directory.FullName,
            });
            Assert.False(result.Ok);
            Assert.Equal("savePath", result.InvalidField);
            Assert.Empty(await h.RowsAsync());
            Assert.Empty(h.Backend.AddLog);
        }
        finally { directory.SetAccessControl(original); }
    }

    [Fact]
    public async Task InvalidDirectoryIsRejectedBeforeAdmissionEvenWhenQueueIsFull()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new() { Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Keep });
        var file = Path.Combine(h.Root, "file");
        await File.WriteAllTextAsync(file, "untouched");

        var result = await h.Engine.AddAsync(new()
        {
            Magnet = EngineHarness.Magnet(2), Purpose = TorrentPurpose.Keep, SavePath = Path.Combine(file, "download"),
        });

        Assert.False(result.Ok);
        Assert.Equal("savePath", result.InvalidField);
        Assert.Single(await h.RowsAsync());
        Assert.Single(h.Backend.AddLog);
        Assert.Equal("untouched", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public void SuccessfulProbeCreatesDirectoryWithoutLeavingFiles()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var path = Path.Combine(root, "new", "folder");
            Assert.Null(DownloadDirectory.Prepare(path));
            Assert.Empty(Directory.EnumerateFileSystemEntries(path));
        }
        finally { Directory.Delete(root, true); }
    }
}
