using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Store;

internal static class StoreJson
{
    internal static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };

    internal static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    internal static T? Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);
}
