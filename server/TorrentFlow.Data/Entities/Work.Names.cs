using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Data.Entities;

public partial class Work
{
    /// <summary>This work's labelled names, else its title and legacy aliases when none are stored or they can't be read.</summary>
    public WorkNames ReadNames() => WorkNames.Read(NamesJson, CanonicalTitle, AliasesJson, Provider);

    /// <summary>This work's provider ids, at least the one its own provider claim carries.</summary>
    public WorkIds ReadIds() => (WorkIds.FromJson(IdsJson) ?? new()).Merge(WorkIds.From(Provider, ProviderId));
}
