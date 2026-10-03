from pathlib import Path
import struct

root = Path(__file__).parent / "edges"
root.mkdir(exist_ok=True)

def element(identifier, data):
    length = max(1, (len(data).bit_length() + 7) // 7)
    size = (len(data) | (1 << (length * 7))).to_bytes(length, "big")
    return bytes.fromhex(identifier) + size + data

header = element("1a45dfa3", element("4282", b"matroska"))
video = element("e0", element("b0", b"\x04\x00") + element("ba", b"\x01\xb4"))
tracks = element("1654ae6b", element("ae", element("83", b"\x01") + video))

def write(name, info, unknown=False, tracks_first=False):
    contents = tracks + info if tracks_first else info + tracks
    # Unknown-sized Cluster is intentionally not parsed, even with misleading later Info.
    contents += bytes.fromhex("1f43b675ff") + element("1549a966", element("4489", struct.pack(">d", 9e9)))
    segment = bytes.fromhex("18538067") + bytes.fromhex("01ffffffffffffff") + contents if unknown else element("18538067", contents)
    (root / (name + ".mkv")).write_bytes(header + segment)

write("float4-default-unknown", element("1549a966", element("4489", struct.pack(">f", 888064))), True)
write("float8-scale-after", element("1549a966", element("4489", struct.pack(">d", 8880640)) + element("2ad7b1", (100000).to_bytes(3, "big"))), tracks_first=True)
for name, value in [("nan", float("nan")), ("infinite", float("inf")), ("zero", 0), ("negative", -1)]:
    write(name, element("1549a966", element("4489", struct.pack(">d", value))))
write("missing-duration", element("1549a966", element("2ad7b1", b"\x0f\x42\x40")))
write("zero-scale", element("1549a966", element("4489", struct.pack(">d", 888064)) + element("2ad7b1", b"\0")))
write("invalid-scale", element("1549a966", element("4489", struct.pack(">d", 888064)) + element("2ad7b1", bytes(9))))
(root / "truncated.mkv").write_bytes(header + bytes.fromhex("1853806701ff"))
(root / "oversized.mkv").write_bytes(header + bytes.fromhex("185380678aff"))
(root / "cluster-before-info.mkv").write_bytes(header + bytes.fromhex("18538067ff1f43b675ff") + element("1549a966", element("4489", struct.pack(">d", 888064))) + tracks)

def chunk(kind, data):
    return kind + struct.pack("<I", len(data)) + data + (b"\0" if len(data) % 2 else b"")

main = bytearray(56)
struct.pack_into("<I", main, 0, 40000)
struct.pack_into("<I", main, 16, 22200)
struct.pack_into("<II", main, 32, 1024, 436)
hdrl = chunk(b"LIST", b"hdrl" + chunk(b"JUNK", b"odd") + chunk(b"avih", main))
avi = b"AVI " + chunk(b"JUNK", b"odd") + hdrl + chunk(b"LIST", b"movi" + bytes(1024))
(root / "odd-padding.avi").write_bytes(b"RIFF" + struct.pack("<I", len(avi)) + avi)
struct.pack_into("<I", main, 16, 0)
avi = b"AVI " + chunk(b"LIST", b"hdrl" + chunk(b"avih", main))
(root / "zero-frames.avi").write_bytes(b"RIFF" + struct.pack("<I", len(avi)) + avi)
