using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Data.Entities;

public partial class Work
{
    /// <summary>This work's labelled names, or its title alone when none are stored.</summary>
    public WorkNames ReadNames() => WorkNames.Read(NamesJson, CanonicalTitle);

    /// <summary>This work's provider ids, at least the one its own provider claim carries.</summary>
    public WorkIds ReadIds() => (WorkIds.FromJson(IdsJson) ?? new()).Merge(WorkIds.From(Provider, ProviderId));
}
