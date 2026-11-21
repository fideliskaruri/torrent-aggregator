using System.Collections.Immutable;
using System.Reflection;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

internal static class ReacquireAudit
{
    internal static void Run(WorkSnapshot work, TargetRow target)
    {
        var build = typeof(TargetPipeline).GetMethod("BuildTargetWrites", BindingFlags.NonPublic | BindingFlags.Static)!;
        var oldHash = new string('f',40);
        TargetRow Reaccept(TargetState state, string? newPick = null)
        {
            var old = target with { State=state, PickedReleaseHash=oldHash, ChosenReleaseHash=oldHash };
            var result=build.Invoke(null,[new string?[]{target.EpisodeId},ImmutableArray<OwnedItem>.Empty,
                new[]{old},work.Work,work.Episodes.ToArray(),"owner",IntentOrigin.Owner,null,null,1080,null,
                "new-batch",DateTimeOffset.UtcNow,newPick,ImmutableHashSet<string>.Empty])!;
            var writes=(ImmutableArray<RowWrite>)result.GetType().GetProperty("Writes")!.GetValue(result)!;
            return (TargetRow)writes.Single().Row;
        }
        foreach(var state in new[]{TargetState.Removed,TargetState.Done})
        {
            var next=Reaccept(state);
            if(next.PickedReleaseHash!=null || next.ChosenReleaseHash!=null || next.State!=TargetState.Wanted)
                throw new Exception($"{state} re-download inherited the previous explicit source and bypassed English search");
            Console.WriteLine($"PASS {state} ordinary re-download clears stale release override");
            var hash=new string('a',40);
            if(Reaccept(state,hash).PickedReleaseHash!=hash)throw new Exception("New explicit source pick was lost");
            Console.WriteLine($"PASS {state} new explicit source pick is retained");
        }
        if(Reaccept(TargetState.Wanted).PickedReleaseHash!=oldHash)
            throw new Exception("An active explicit pick changed on duplicate admission");
        Console.WriteLine("PASS duplicate active admission preserves current explicit pick");
    }
}
