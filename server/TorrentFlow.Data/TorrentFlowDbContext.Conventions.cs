using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using System.Globalization;

namespace TorrentFlow.Data;

public partial class TorrentFlowDbContext
{
    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        // Prisma wrote DateTime columns as ISO-8601 UTC text ("2026-08-10T21:28:45.221+00:00").
        // Keep writing the same shape so text comparisons and ORDER BY stay correct for old and new rows.
        configurationBuilder.Properties<DateTime>().HaveConversion<IsoUtcDateTimeConverter>();
        configurationBuilder.Properties<DateTime?>().HaveConversion<NullableIsoUtcDateTimeConverter>();
    }
}

public sealed class IsoUtcDateTimeConverter() : ValueConverter<DateTime, string>(
    v => IsoUtc.Format(v),
    v => IsoUtc.Parse(v));

public sealed class NullableIsoUtcDateTimeConverter() : ValueConverter<DateTime?, string?>(
    v => v.HasValue ? IsoUtc.Format(v.Value) : null,
    v => v == null ? null : IsoUtc.Parse(v));

public static class IsoUtc
{
    public static string Format(DateTime value)
    {
        var utc = value.Kind == DateTimeKind.Unspecified
            ? DateTime.SpecifyKind(value, DateTimeKind.Utc)
            : value.ToUniversalTime();
        return utc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'+00:00'", CultureInfo.InvariantCulture);
    }

    public static DateTime Parse(string value)
    {
        if (long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ms))
            return DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime;
        return DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).UtcDateTime;
    }
}
