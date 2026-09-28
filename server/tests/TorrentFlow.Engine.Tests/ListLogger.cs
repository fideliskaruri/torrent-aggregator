using Microsoft.Extensions.Logging;

namespace TorrentFlow.Engine.Tests;

internal sealed class ListLogger<T> : ILogger<T>
{
    public readonly List<(LogLevel Level, string Message)> Lines = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        lock (Lines) Lines.Add((logLevel, formatter(state, exception)));
    }

    public bool Has(string text)
    {
        lock (Lines) return Lines.Any(l => l.Message.Contains(text, StringComparison.Ordinal));
    }
}
