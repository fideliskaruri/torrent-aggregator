using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>What smartCategorize sees of a release: the title plus the optional hints a send carries.</summary>
public sealed record SmartCategoryInput(string Title, IReadOnlyList<string> Tags, MediaMetadata? Metadata, string? Source, string? SearchCategory);

/// <summary>smartCategorize's verdict. Kind: anime | movies | tv | music | games | software | books | other.</summary>
public sealed record SmartCategory(string Kind, string Category, string Confidence);

/// <summary>
/// The release classifier behind resolveSmartSendTarget (smart-category.ts). The Search module owns the heuristics;
/// the engine uses them to nest downloads under &lt;category&gt;/&lt;show&gt;/Season NN the way the Next app does.
/// </summary>
public interface ISmartCategorizer
{
    SmartCategory Categorize(SmartCategoryInput input, IReadOnlyList<string> userCategories);

    /// <summary>showFolderName: the folder a release nests under, or empty when nothing usable remains.</summary>
    string ShowFolder(string title, MediaMetadata? metadata);

    /// <summary>seasonFolderSegment(parseEpisode(title)): "Season NN" for a single known season, else null.</summary>
    string? SeasonFolder(string title);
}
