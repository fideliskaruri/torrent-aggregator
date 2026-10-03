# Local licensed-fixture seeder

Build with `dotnet build tools\.jelly-proof\Seeder\Seeder.csproj`.
Run `dotnet <Seeder.dll> <fixture directory> http://127.0.0.1:<TorrentFlow port>`.
There is deliberately no default server address: separate proof instances must
not silently inject peers into an earlier instance.

The fixture directory contains `.torrent` files and a `seed` directory. For the
Sintel and Big Buck Bunny torrents, put `Sintel.mp4` and `BigBuckBunny.mp4`
directly inside `seed`, not inside title subdirectories. Copy licensed fixtures;
never move the source files. Startup rejects incompletely hashed fixtures.

The tool reads the supplied development instance's engine diagnostics. It starts
seeding and advertises its local peer only for registered, active hashes, using
that instance's current BitTorrent listen port. An unrelated active torrent is
not evidence that the requested hash can accept a handshake. The ordinary local
peer advertisement loop continues through the metadata-to-payload transition;
it does not retry filing requests or change Engine timeouts or encryption.
An unavailable instance is reported, rather than silently ignored.
