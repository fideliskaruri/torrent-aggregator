using System.Security.Cryptography;

namespace TorrentFlow.Data;

/// <summary>Collision-resistant, sortable ids shaped like Prisma's cuid() (lowercase base36, starts with 'c').</summary>
public static class Ids
{
    private static long _counter = RandomNumberGenerator.GetInt32(int.MaxValue);
    private const string Alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

    public static string New()
    {
        Span<char> random = stackalloc char[12];
        for (var i = 0; i < random.Length; i++) random[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        var time = ToBase36(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()).PadLeft(8, '0');
        var count = ToBase36(Interlocked.Increment(ref _counter) % 1_679_616).PadLeft(4, '0');
        return string.Concat("c", time, count, new string(random));
    }

    private static string ToBase36(long value)
    {
        if (value == 0) return "0";
        Span<char> buf = stackalloc char[16];
        var pos = buf.Length;
        while (value > 0) { buf[--pos] = Alphabet[(int)(value % 36)]; value /= 36; }
        return new string(buf[pos..]);
    }
}
