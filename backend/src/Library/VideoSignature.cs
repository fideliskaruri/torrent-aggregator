namespace TorrentFlow.Library;

internal static class VideoSignature
{
    internal static bool Recognized(ReadOnlySpan<byte> header) => header.Length >= 12 &&
        !header[..2].SequenceEqual("MZ"u8) && !header[..2].SequenceEqual("PK"u8) &&
        (header[..4].SequenceEqual(new byte[] { 0x1a, 0x45, 0xdf, 0xa3 }) ||
         header.Slice(4, 4).SequenceEqual("ftyp"u8) ||
         header.Slice(4, 4).SequenceEqual("moov"u8) ||
         header.Slice(4, 4).SequenceEqual("mdat"u8) ||
         header[..4].SequenceEqual("RIFF"u8) && header.Slice(8, 4).SequenceEqual("AVI "u8) ||
         header[0] == 0x47 || header[4] == 0x47 ||
         header[..4].SequenceEqual(new byte[] { 0, 0, 1, 0xba }) ||
         header.Length >= 16 && header[..16].SequenceEqual(new byte[]
             { 0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0, 0xaa, 0, 0x62, 0xce, 0x6c }));
}
