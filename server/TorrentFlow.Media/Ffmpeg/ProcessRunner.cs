using System.Diagnostics;
using System.Text;

namespace TorrentFlow.Media.Ffmpeg;

/// <summary>Process seam so HLS/VOD/subtitle lifecycles can be tested with a fake runner.</summary>
public interface IProcessRunner
{
    IRunningProcess Start(string fileName, IReadOnlyList<string> arguments, string? workingDirectory = null);
}

public interface IRunningProcess : IDisposable
{
    int Id { get; }
    /// <summary>Raw stdout; consumers that ignore it must still let the runner drain it.</summary>
    Stream StandardOutput { get; }
    /// <summary>Completes with the exit code (non-zero / -1 after a kill).</summary>
    Task<int> Exited { get; }
    bool HasExited { get; }
    /// <summary>The last 4096 characters of stderr.</summary>
    string StderrTail { get; }
    event Action<string>? StderrLine;
    void Kill();
}

public sealed class SystemProcessRunner : IProcessRunner
{
    public IRunningProcess Start(string fileName, IReadOnlyList<string> arguments, string? workingDirectory = null)
    {
        var psi = new ProcessStartInfo(fileName)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = workingDirectory ?? "",
        };
        foreach (var a in arguments) psi.ArgumentList.Add(a);
        var process = Process.Start(psi) ?? throw new InvalidOperationException($"could not start {fileName}");
        return new SystemRunningProcess(process);
    }

    private sealed class SystemRunningProcess : IRunningProcess
    {
        private readonly Process _process;
        private readonly StringBuilder _stderr = new();
        private readonly TaskCompletionSource<int> _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public SystemRunningProcess(Process process)
        {
            _process = process;
            Id = process.Id;
            _process.EnableRaisingEvents = true;
            _process.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is null) return;
                lock (_stderr)
                {
                    _stderr.Append(e.Data).Append('\n');
                    if (_stderr.Length > 8192) _stderr.Remove(0, _stderr.Length - 4096);
                }
                StderrLine?.Invoke(e.Data);
            };
            _process.BeginErrorReadLine();
            _ = WaitAsync();
        }

        private async Task WaitAsync()
        {
            try
            {
                await _process.WaitForExitAsync();
                _exited.TrySetResult(_process.ExitCode);
            }
            catch (Exception) { _exited.TrySetResult(-1); }
        }

        public int Id { get; }
        public Stream StandardOutput => _process.StandardOutput.BaseStream;
        public Task<int> Exited => _exited.Task;
        public bool HasExited => _exited.Task.IsCompleted;
        public event Action<string>? StderrLine;

        public string StderrTail
        {
            get
            {
                lock (_stderr)
                {
                    var s = _stderr.ToString();
                    return s.Length > 4096 ? s[^4096..] : s;
                }
            }
        }

        public void Kill()
        {
            try { if (!_process.HasExited) _process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
        }

        public void Dispose()
        {
            Kill();
            _process.Dispose();
        }
    }
}

public sealed record ProcessRunResult(int ExitCode, byte[] Stdout, string Stderr, string? Failure)
{
    /// <summary>null | "aborted" | "timeout" | "oversize" | "spawn".</summary>
    public bool Ok => Failure is null && ExitCode == 0;
}

public static class ProcessRuns
{
    /// <summary>Runs to exit, buffering stdout up to <paramref name="maxStdoutBytes"/>; kills on timeout/abort/oversize.</summary>
    public static async Task<ProcessRunResult> RunAsync(IProcessRunner runner, string file, IReadOnlyList<string> args, TimeSpan timeout, long maxStdoutBytes, CancellationToken ct)
    {
        IRunningProcess proc;
        try { proc = runner.Start(file, args); }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            return new ProcessRunResult(-1, [], ex.Message, "spawn");
        }
        using (proc)
        {
            using var timeoutCts = new CancellationTokenSource(timeout);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);
            var buffer = new MemoryStream();
            string? failure = null;
            try
            {
                var chunk = new byte[81920];
                while (true)
                {
                    var n = await proc.StandardOutput.ReadAsync(chunk, linked.Token);
                    if (n == 0) break;
                    buffer.Write(chunk, 0, n);
                    if (buffer.Length > maxStdoutBytes) { failure = "oversize"; break; }
                }
                if (failure is null) await proc.Exited.WaitAsync(linked.Token);
            }
            catch (OperationCanceledException)
            {
                failure = ct.IsCancellationRequested ? "aborted" : "timeout";
            }
            catch (IOException) { }
            if (failure is not null)
            {
                proc.Kill();
                try { await proc.Exited.WaitAsync(TimeSpan.FromSeconds(5)); } catch (TimeoutException) { }
            }
            var code = proc.HasExited ? await proc.Exited : -1;
            return new ProcessRunResult(code, buffer.ToArray(), proc.StderrTail, failure);
        }
    }
}
