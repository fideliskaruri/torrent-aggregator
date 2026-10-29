using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public static class PhysicalFiles
{
    public static long AllocatedBytes(string path) => PhysicalFileAllocation.AllocatedBytes(path);
}
