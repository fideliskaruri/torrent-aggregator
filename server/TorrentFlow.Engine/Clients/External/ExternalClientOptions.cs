namespace TorrentFlow.Engine.Clients.External;

public sealed class ExternalClientOptions
{
    public const string Section = "TorrentFlow:ExternalClients";

    public bool Enabled { get; set; }
}
