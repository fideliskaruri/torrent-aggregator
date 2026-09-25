using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Tests;

/// <summary>Expected values come from Node: s.normalize("NFKC") and s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").</summary>
public sealed class NormalizationParityTests
{
    [Theory]
    [InlineData("Pok\u00e9mon \uFF21\u2460 \u00c5", "Pok\u00e9mon A1 \u00c5", "Pokemon A1 A")]
    [InlineData("\u0419\u043e\u0436\u0438\u043a", "\u0419\u043e\u0436\u0438\u043a", "\u0418\u043e\u0436\u0438\u043a")]
    [InlineData("Ti\u1ebfng Vi\u1ec7t", "Ti\u1ebfng Vi\u1ec7t", "Tieng Viet")]
    [InlineData("\ufb01nal \u2163", "final IV", "final IV")]
    public void MatchesJavaScriptNormalize(string input, string nfkc, string nfkdWithoutMarks)
    {
        Assert.Equal(nfkc, TextUtil.CompatibilityFold(input, stripAccents: false));
        var folded = new string(TextUtil.CompatibilityFold(input, stripAccents: true).Where(c => c is < '\u0300' or > '\u036f').ToArray());
        Assert.Equal(nfkdWithoutMarks, folded);
    }
}
