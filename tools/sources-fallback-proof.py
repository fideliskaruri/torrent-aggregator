"""Fallback/opt-in protocol integration through real loopback HTTP and the real host."""
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROOF = ROOT / "tools" / ".sources-proof"
KEY = "fixture-key-not-a-credential"
HASH = "0123456789abcdef0123456789abcdef01234567"
EVENTS = []


def rss(title="Sintel Café S99E99", bad=False, trailer=True):
    title = "broken & interior" if bad else title
    xml = f'''<?xml version="1.0" encoding="iso-8859-1"?>
<rss xmlns:t="http://torznab.com/schemas/2015/feed"><channel><item>
<title>{title}</title><guid>fixture</guid><link>https://fixture-user:{KEY}@example.invalid/file.torrent?apikey={KEY}</link>
<info_hash>{HASH}</info_hash><size>123456</size><seeders>10</seeders><leechers>2</leechers>
<description><![CDATA[Size: 1.25GB Seeds: 10 Leechers: 2 Peers: 2 Hash: {HASH}]]></description>
<enclosure url="https://example.invalid/{HASH}.torrent" length="123456"/>
<t:attr name="infohash" value="{HASH}"/><t:attr name="seeders" value="10"/><t:attr name="peers" value="12"/>
<pubDate>Sat, 03 Oct 2026 05:00:00 GMT</pubDate></item></channel></rss>'''
    return (xml + ('<script>analytics = 1 < 2;</script>' if trailer else "")).encode("iso-8859-1")


class Site(http.server.BaseHTTPRequestHandler):
    slow_caps = False

    def log_message(self, *_):
        pass

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        params = urllib.parse.parse_qs(url.query)
        q = params.get("q", params.get("search", [""]))[0]
        EVENTS.append({"path": url.path, "t": params.get("t", [None])[0], "query": q, "at": time.monotonic()})
        status, content_type = 200, "application/json"
        if url.path.startswith("/torznab"):
            if params.get("apikey") != [KEY]:
                status, body = 401, b"unauthorized"
            elif params.get("t") == ["caps"]:
                if self.slow_caps:
                    time.sleep(7)
                body = b'<caps><searching><search available="yes" supportedParams="q"/><tv-search available="no" supportedParams="q"/></searching></caps>'
            elif q == "auth":
                body = b'<error code="103" description="Incorrect API key"/>'
            elif q == "rate":
                status, body = 429, b"slow down"
            elif q == "pages":
                offset = int(params["offset"][0])
                nested = f"https://example.invalid/announce?apikey={KEY}"
                for _ in range(5):
                    nested = "https://example.invalid/nested?ws=" + urllib.parse.quote(nested, safe="")
                magnet = "magnet:?ws=" + urllib.parse.quote(nested, safe="")
                row = lambda i: (f'<item><title>Hashless raw {i}</title><guid>https://example.invalid/{i}?passkey={KEY}</guid>'
                                 f'<enclosure url="https://example.invalid/{i}.torrent?apikey={KEY}" length="123456"/>'
                                 f'<attr name="magneturl" value="{magnet}"/></item>')
                rows = "".join(row(i) for i in range(offset, min(offset + 2, 3)))
                body = f'<rss><channel><response offset="{offset}" total="3"/>{rows}</channel></rss>'.encode()
            else:
                body = rss(trailer=False)
            content_type = "application/xml; charset=iso-8859-1"
        elif url.path.startswith("/1337x"):
            content_type = "text/html"
            if "/detail/" in url.path:
                body = f'<a href="magnet:?xt=urn:btih:{int(url.path.rsplit("/", 1)[-1]):040x}">Magnet</a>'.encode()
            else:
                rows = "".join(f'<tr><td class="coll-1 name"><a href="/1337x/detail/{i+1}">Raw S99E99 {i}</a></td>'
                               '<td class="coll-2 seeds">4</td><td class="coll-3 leeches">2</td>'
                               '<td class="coll-4">1.25GB</td><td class="coll-date">6am</td></tr>' for i in range(20))
                body = f'<table class="table-list"><tbody>{rows}</tbody></table>'.encode()
        elif url.path.startswith("/bitsearch"):
            content_type = "text/html"
            if q == "rate":
                status, body = 429, b"slow down"
            else:
                body = (f'<input name="q"><div class="bg-white"><h3><a href="/torrent/id">Raw S99E99</a></h3>'
                        f'<a href="magnet:?xt=urn:btih:{HASH}">Magnet</a>'
                        '<div class="text-sm text-gray-600"><span><span>TV</span></span><span><span>1.25GB</span></span>'
                        '<span><span>10/3/2026</span></span></div>'
                        '<span class="text-green-600"><span class="font-medium">10</span></span>'
                        '<span class="text-red-600"><span class="font-medium">2</span></span></div>').encode()
        elif url.path.startswith("/therarbg"):
            body = json.dumps({"results": [{"n": "Raw wrong season S99E99", "h": HASH, "s": 123456,
                                          "se": 10, "le": 2, "a": 1791000000, "pk": 1}]}).encode()
        elif url.path.startswith("/subsplease"):
            # Base32 wire format is real and must normalize to the same 20-byte hash.
            import base64
            encoded = base64.b32encode(bytes.fromhex(HASH)).decode()
            body = json.dumps({"row": {"downloads": [{"magnet": f"magnet:?xt=urn:btih:{encoded}&dn=Raw%20S99E99&xl=123456",
                                                     "res": "1080"}], "release_date": "2026-10-03T05:00:00Z"}}).encode()
        elif url.path.startswith("/archive"):
            row = {"title": "Public domain fixture", "identifier": "pd-fixture", "btih": HASH, "item_size": 123456,
                   "licenseurl": "https://creativecommons.org/publicdomain/zero/1.0/"}
            other = dict(row, title="Not public domain", identifier="not-pd", btih="2" * 40,
                         licenseurl="https://creativecommons.org/licenses/by/4.0/")
            body = json.dumps({"response": {"numFound": 2, "docs": [row, other]}}).encode()
        else:
            content_type = "application/rss+xml; charset=" + ("utf-7" if q == "unsupported-charset" else "iso-8859-1")
            body = rss(bad=q == "broken")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if status == 429:
            self.send_header("Retry-After", "8")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def call(source, q="Sintel", category="all", stream=False):
    started = time.monotonic()
    params = urllib.parse.urlencode({"source": source, "q": q, "category": category, "stream": str(stream).lower()})
    with urllib.request.urlopen("http://127.0.0.1:3945/api/dev/sources/search?" + params, timeout=8) as response:
        if stream:
            result = [{"atMs": round((time.monotonic() - started) * 1000), "response": json.loads(line)} for line in response]
        else:
            result = json.load(response)
    assert KEY not in json.dumps(result), "A URI credential leaked into the dev response."
    return {"latencyMs": round((time.monotonic() - started) * 1000), "response": result}


def main():
    stub = http.server.ThreadingHTTPServer(("127.0.0.1", 3946), Site)
    threading.Thread(target=stub.serve_forever, daemon=True).start()
    env = os.environ.copy()
    env["ASPNETCORE_ENVIRONMENT"] = "Development"
    args = ["dotnet", str(ROOT / "backend" / ".sources-build" / "bin" / "Api" / "debug" / "TorrentFlow.dll"),
            "--urls", "http://127.0.0.1:3945", "--TorrentFlow:DataDirectory", r"D:\code\memtest\rebuild-dev\data",
            "--TorrentFlow:Scheduler:Disabled", "true", "--background", "--no-browser"]
    ids = ["therarbg", "bitsearch", "limetorrents", "torrentdownloads", "torrentdownloadinfo", "1337x", "subsplease", "archive", "torznab"]
    for source in ids:
        host = "localhost" if source == "torznab" else "127.0.0.1"
        args += [f"--TorrentFlow:Sources:{source}:BaseUrl", f"http://{host}:3946/{source}"]
        if source in ["1337x", "subsplease", "archive", "torznab"]:
            args += [f"--TorrentFlow:Sources:{source}:Enabled", "true"]
    args += ["--TorrentFlow:Sources:torznab:ApiKey", KEY]
    evidence = {"checks": {}}
    with (PROOF / "fallback-stub-server.log").open("w") as log:
        process = subprocess.Popen(args, env=env, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        evidence["pid"] = process.pid
        try:
            for _ in range(40):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:3945/api/health", timeout=1) as response:
                        if json.load(response)["ready"]:
                            break
                except OSError:
                    time.sleep(.2)
            else:
                raise AssertionError("Server not ready")
            for source in ids:
                if source == "1337x":
                    continue
                answer = call(source)
                evidence["checks"][source] = answer
                assert answer["response"]["outcome"] == "Success", (source, answer)
                assert len(answer["response"]["results"]) == 1, source
            for source in ["limetorrents", "torrentdownloads", "torrentdownloadinfo"]:
                row = evidence["checks"][source]["response"]["results"][0]
                assert row["name"] == "Sintel Café S99E99", row
                assert row["listedSeeders"] == 10 and row["listedLeechers"] == 2
            assert evidence["checks"]["torrentdownloadinfo"]["response"]["results"][0]["bytes"] == 1250000000
            assert evidence["checks"]["subsplease"]["response"]["results"][0]["hash"] == HASH
            assert evidence["checks"]["subsplease"]["response"]["results"][0]["listedSeeders"] is None
            archive = evidence["checks"]["archive"]["response"]["results"][0]
            assert archive["listedSeeders"] is None and len(archive["webSeeds"]) == 1
            assert "Public domain" in archive["name"]
            torz = evidence["checks"]["torznab"]["response"]
            assert torz["diagnostics"]["requests"] == 2
            assert [e["t"] for e in EVENTS if e["path"] == "/torznab"] == ["caps", "search"]
            assert "%5Bredacted%5D" in torz["results"][0]["torrentUri"]
            evidence["checks"]["torznabPages"] = call("torznab", "pages", category="series", stream=True)
            rows = evidence["checks"]["torznabPages"]["response"][-1]["response"]["results"]
            assert len(rows) == 3 and all(row["hash"] == "" and row["listedSeeders"] is None for row in rows)
            assert all("%5Bredacted%5D" in row["sourceItemId"] for row in rows)
            assert evidence["checks"]["torznabPages"]["response"][-1]["response"]["complete"]
            assert evidence["checks"]["torznabPages"]["response"][-1]["response"]["diagnostics"]["requests"] == 3
            evidence["checks"]["torznabAuth"] = call("torznab", "auth")
            assert evidence["checks"]["torznabAuth"]["response"]["outcome"] == "Failed"
            assert evidence["checks"]["torznabAuth"]["response"]["diagnostics"]["requests"] == 2
            Site.slow_caps = True
            evidence["checks"]["torznabCapsDeadline"] = call("torznab")
            Site.slow_caps = False
            assert evidence["checks"]["torznabCapsDeadline"]["response"]["outcome"] == "TimedOut"
            assert 5700 <= evidence["checks"]["torznabCapsDeadline"]["latencyMs"] <= 6500
            assert evidence["checks"]["torznabCapsDeadline"]["response"]["diagnostics"]["requests"] == 1
            evidence["checks"]["torznab429"] = call("torznab", "rate")
            evidence["checks"]["torznabCooldown"] = call("torznab", "skip")
            assert evidence["checks"]["torznab429"]["response"]["diagnostics"]["requests"] == 2
            assert evidence["checks"]["torznabCooldown"]["response"]["outcome"] == "CoolingDown"
            assert evidence["checks"]["torznabCooldown"]["response"]["diagnostics"]["requests"] == 0
            evidence["checks"]["malformed"] = call("torrentdownloads", "broken")
            assert evidence["checks"]["malformed"]["response"]["outcome"] == "Failed"
            assert not evidence["checks"]["malformed"]["response"]["complete"]
            evidence["checks"]["unsupportedCharset"] = call("torrentdownloads", "unsupported-charset")
            assert evidence["checks"]["unsupportedCharset"]["response"]["outcome"] == "Failed"
            assert evidence["checks"]["unsupportedCharset"]["response"]["diagnostics"]["code"] == "SourceFailure"
            evidence["checks"]["detailDeadline"] = call("1337x", stream=True)
            batches = evidence["checks"]["detailDeadline"]["response"]
            assert batches[-1]["response"]["outcome"] == "TimedOut"
            assert 1 <= len(batches[-1]["response"]["results"]) <= 5
            assert batches[0]["atMs"] < 3000
            assert all(row["uploadedAt"] is None for row in batches[-1]["response"]["results"])
            evidence["checks"]["429"] = call("bitsearch", "rate")
            evidence["checks"]["cooldown"] = call("bitsearch", "skip")
            assert evidence["checks"]["429"]["response"]["diagnostics"]["httpStatus"] == 429
            assert evidence["checks"]["cooldown"]["response"]["outcome"] == "CoolingDown"
            assert evidence["checks"]["cooldown"]["latencyMs"] < 300
            assert evidence["checks"]["cooldown"]["response"]["diagnostics"]["requests"] == 0
            assert not any(e["query"] == "skip" for e in EVENTS)
            evidence["passed"] = True
        finally:
            process.terminate()
            process.wait(timeout=10)
            evidence["stoppedPid"] = process.pid
            evidence["upstreamStarts"] = EVENTS
            (PROOF / "fallback-infrastructure.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
            stub.shutdown()
            stub.server_close()
    print("PASS: nine protocols, charset/trailer/malformed feed, base32, public-domain/no synthetic seeds,")
    print("Torznab caps/search+redaction, 1337x bounded details, BitSearch real 429/cooldown.", process.pid, "stopped")


if __name__ == "__main__":
    main()
