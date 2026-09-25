using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Browse;

namespace TorrentFlow.Metadata.Tests;

/// <summary>Port of src/lib/browse/theatrical-window.test.ts (classification, labels, discovery gating).</summary>
public class TheatricalWindowTests
{
    private const string Past = "2026-07-15";
    private const string Future = "2026-09-01";
    private static readonly DateTimeOffset Today = new(2026, 7, 30, 0, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Noon = new(2026, 7, 30, 12, 0, 0, TimeSpan.Zero);

    private static TmdbReleaseDate E(string? date, int type) => new(type, date);

    private static HomeReleaseSignal Classify(params TmdbReleaseDate[] entries) => HomeRelease.ClassifyHomeReleaseEvidence(entries, Today);

    [Fact]
    public void Theatrical_only_past_has_no_home_release()
    {
        var c = Classify(E("2026-07-15T00:00:00.000Z", 1), E("2026-07-15T00:00:00.000Z", 2), E("2026-07-15T00:00:00.000Z", 3));
        Assert.Null(c.ReleasedAt);
        Assert.Null(c.NextHomeReleaseAt);
        Assert.Equal(Past, c.TheatricalReleasedAt);
    }

    [Fact] public void Premiere_only_is_not_a_home_release() => Assert.Null(Classify(E(Past, 1)).ReleasedAt);

    [Theory]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public void Past_home_release_types_count(int type) => Assert.Equal(Past, Classify(E(Past, 3), E(Past, type)).ReleasedAt);

    [Fact]
    public void Future_digital_is_next_home_release()
    {
        var c = Classify(E(Past, 3), E(Future, 4));
        Assert.Null(c.ReleasedAt);
        Assert.Equal(Future, c.NextHomeReleaseAt);
    }

    [Fact]
    public void Empty_results_are_unknown()
    {
        var c = Classify();
        Assert.False(c.Checked);
        Assert.Null(c.ReleasedAt);
        Assert.Null(c.NextHomeReleaseAt);
    }

    [Fact] public void Missing_dates_are_skipped() => Assert.Null(Classify(E(null, 4), E("", 4), E(null, 5)).ReleasedAt);

    [Fact] public void Earliest_past_home_release_wins_across_countries() => Assert.Equal("2026-06-01", Classify(E(Past, 4), E("2026-06-01", 5)).ReleasedAt);

    [Fact]
    public void Mixed_past_and_future_home_releases()
    {
        var c = Classify(E(Past, 4), E(Future, 5));
        Assert.NotNull(c.ReleasedAt);
        Assert.Equal(Future, c.NextHomeReleaseAt);
    }

    [Fact] public void Today_is_inclusive() => Assert.Equal("2026-07-30", Classify(E("2026-07-30", 4)).ReleasedAt);

    [Fact] public void Timestamps_are_parsed_to_days() => Assert.Equal(Past, Classify(E($"{Past}T00:00:00.000Z", 4)).ReleasedAt);

    [Fact]
    public void Release_dates_are_flattened_from_tmdb_detail()
    {
        var detail = System.Text.Json.JsonDocument.Parse("""
            {"release_dates":{"results":[{"iso_3166_1":"US","release_dates":[{"type":3,"release_date":"2026-07-15T00:00:00.000Z"}]},
              {"iso_3166_1":"DE","release_dates":[{"type":4,"release_date":"2026-09-01T00:00:00.000Z"}]}]}}
            """).RootElement;
        Assert.Equal([new TmdbReleaseDate(3, "2026-07-15T00:00:00.000Z"), new TmdbReleaseDate(4, "2026-09-01T00:00:00.000Z")], HomeRelease.ReleaseDatesOf(detail));
    }

    [Theory]
    [InlineData(false, null, false, null)]
    [InlineData(true, null, true, "In cinemas")]
    [InlineData(true, "2026-08-01", true, "Digital Aug 2026")]
    [InlineData(true, "2026-12-25", true, "Digital Dec 2026")]
    [InlineData(true, "2027-01-10", true, "Digital Jan 2027")]
    [InlineData(true, "2026-09-15", true, "Digital Sep 2026")]
    [InlineData(true, "2026-08-15", true, "Digital Aug 2026")]
    public void Theatrical_window_labels(bool inWindow, string? next, bool gated, string? label)
    {
        var s = ReleaseGates.TheatricalWindowStatus(inWindow, next);
        Assert.Equal(gated, s.InTheatricalWindow);
        Assert.Equal(label, s.TheatricalLabel);
    }

    public static TheoryData<string, string, string?, TmdbReleaseDate[]?, bool, string?> DiscoveryCases => new()
    {
        { "theatrical-only film", "movie", "2026-07-15", [E(Past, 3)], true, "In cinemas" },
        { "digitally released film", "movie", "2026-07-15", [E(Past, 3), E(Past, 4)], false, null },
        { "unknown provider data", "movie", "2026-07-15", null, false, null },
        { "empty provider response", "movie", "2026-07-15", [], false, null },
        { "future theatrical evidence", "movie", "2026-01-01", [E(Future, 3)], false, null },
        { "unknown primary date", "movie", null, [E(Past, 3)], false, null },
        { "series with theatrical evidence", "tv", "2026-07-15", [E(Past, 3)], false, null },
        { "theatrical film with future digital", "movie", "2026-07-15", [E(Past, 3), E(Future, 4)], true, "Digital Sep 2026" },
    };

    [Theory]
    [MemberData(nameof(DiscoveryCases))]
    public void Discovery_rails_gate_only_confirmed_theatrical_only_movies(string name, string mediaType, string? primaryDate,
        TmdbReleaseDate[]? results, bool expectedGate, string? expectedLabel)
    {
        var signal = HomeRelease.ClassifyHomeReleaseEvidence(results, Noon);
        var row = new CatalogEntry
        {
            Id = $"{mediaType}-{primaryDate ?? "unknown"}", WorkKey = $"{mediaType}:test", Title = "Test title", Year = 2020, MediaType = mediaType,
            ReleaseDate = primaryDate is null ? null : DateTime.Parse(primaryDate + "T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.AdjustToUniversal),
            Source = "trending", Rank = 0, RefreshedAt = new DateTime(2026, 7, 30, 0, 0, 0, DateTimeKind.Utc),
        };
        var item = BrowseService.ToRailItem(row, signal, Noon);
        var gate = ReleaseGates.Gate(item.ReleaseDate, item.MediaType, item.InTheatricalWindow, item.NextHomeReleaseAt, Noon);
        Assert.True(expectedGate == item.InTheatricalWindow, $"{name}: rail payload gate");
        Assert.Equal(expectedGate, gate.Gated);
        Assert.Equal(expectedLabel, gate.Label);
        Assert.Null(item.Availability);
    }
}
