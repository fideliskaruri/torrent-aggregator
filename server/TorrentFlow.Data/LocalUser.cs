namespace TorrentFlow.Data;

/// <summary>TorrentFlow is single-user on localhost; every row is scoped to this user so real accounts can be added later.</summary>
public static class LocalUser
{
    public const string Id = "local";
    public const string Name = "You";
}
