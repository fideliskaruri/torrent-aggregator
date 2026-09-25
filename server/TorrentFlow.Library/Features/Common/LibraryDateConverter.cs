using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Library.Features.Common;

internal sealed class LibraryDateConverter : JsonConverter<DateTime>
{
    public override DateTime Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.GetDateTime().ToUniversalTime();
    public override void Write(Utf8JsonWriter writer, DateTime value, JsonSerializerOptions options) => writer.WriteStringValue(LibraryJson.Iso(value));
}
