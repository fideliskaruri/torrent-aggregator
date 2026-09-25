using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search;

/// <summary>smartCategorize / showFolderName / seasonFolderSegment over the Search module's classifier.</summary>
internal sealed class SmartCategorizer : ISmartCategorizer
{
    public SmartCategory Categorize(SmartCategoryInput input, IReadOnlyList<string> userCategories)
    {
        var release = new TorrentResult
        {
            Id = "", Title = input.Title ?? "", Source = string.IsNullOrWhiteSpace(input.Source) ? "apibay" : input.Source!, SourceUrl = "",
            Tags = [.. input.Tags], Metadata = input.Metadata,
        };
        var kind = ContentClassifier.Detect(release, input.SearchCategory);
        return new(kind, ContentClassifier.CategoryLabel(kind, [.. userCategories]), ContentClassifier.Confidence(release, kind));
    }

    public string ShowFolder(string title, MediaMetadata? metadata) => ContentClassifier.ShowFolder(title, metadata);

    public string? SeasonFolder(string title) => EpisodeParser.SeasonFolder(EpisodeParser.Parse(title));
}
