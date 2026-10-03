# Probe metadata and observation

Torrent HTTP metadata permits at most five redirects, including relative
locations. Every HTTP(S) hop retains the public-address connection check and
rejects embedded credentials. The whole chain, headers and body share one
six-second deadline. Bodies are limited to 20 MiB even without Content-Length;
`application/x-bittorrent` and `application/octet-stream` are accepted. A
redirected magnet is parsed and hash-checked instead of sent to HTTP.

Both probe attachment and payload admission use this resolver. Torrent metadata
and redirected magnets must match the candidate's expected hash.

The optional progressive observation port takes Check's predicate; Engine never
decides a health band. An early stop uses the same stop, disk flush, capability
rotation and release cleanup as a full probe. Observation duration excludes the
final disk flush. A late integrity failure drains the remaining window before
returning, so it cannot create an early Weak or Dead result.
