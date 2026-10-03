using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Api;

internal static class SecretFiles
{
    public static SecretReference? FromTmdbEnvironment(string dataDirectory)
    {
        var secret = Environment.GetEnvironmentVariable("TMDB_API_KEY");
        if (string.IsNullOrWhiteSpace(secret)) return null;
        var directory = Path.Combine(dataDirectory, "secrets");
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The secrets directory must not be a symbolic link or junction.");
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(directory);
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!,
                FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(directory).SetAccessControl(acl);
        }
        else
        {
            Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        var bytes = Encoding.UTF8.GetBytes(secret);
        var existing = Directory.EnumerateFiles(directory, "tmdb-*.secret").FirstOrDefault(file =>
            (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0 && File.ReadAllBytes(file).AsSpan().SequenceEqual(bytes));
        if (existing is not null)
        {
            CryptographicOperations.ZeroMemory(bytes);
            return new(Path.GetFileNameWithoutExtension(existing), 1);
        }
        var id = "tmdb-" + Guid.NewGuid().ToString("N");
        var path = Path.Combine(directory, id + ".secret");
        if (!File.Exists(path))
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None,
            };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using var stream = new FileStream(path, options);
            stream.Write(bytes);
            stream.Flush(flushToDisk: true);
        }
        CryptographicOperations.ZeroMemory(bytes);
        return new(id, 1);
    }
}
