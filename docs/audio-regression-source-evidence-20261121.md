# Real-source English-audio regression evidence

Owner reported v0.4.1 downloaded only French/Japanese for Classroom of the Elite.
Read-only metadata/search checks; no acquisition/replacement/media reads performed.

Affected owned entry: Season1 Episode1; selected hash
`07d77fa13ec33dd235557934e60ee523356a354b`.
Installed previous-source endpoint identifies Nyaa release:
`Classroom.of.the.Elite.S01.CUSTOM.MULTi.1080p.BluRay.x264-T3KASHi`.
Nyaa https://nyaa.si/view/1733389 explicitly categorizes it Non-English-translated
and describes French (Crunchyroll) plus Japanese (Japanese Blu-ray) audio.
Live RSS reported6 seeders. The source page, not only the generic MULTi name,
would have exposed the mismatch before payload download.

English dub exists: Apple TV's S1E1 page explicitly lists English AAC audio:
https://tv.apple.com/us/episode/what-is-evil-whatever-springs-from-weakness/umc.cmc.6awgquyq9gciiqqevhs2k4lb7
Crunchyroll has its own S2E1 English-dub upload https://www.youtube.com/watch?v=ASSsbXuGuoA .

Live searches of configured providers found:
- Nyaa https://nyaa.si/view/1495607: YURASUKA S01 1080p BluRay dual audio,
 56 reported seeds. Uploader explicitly distinguishes English5.1 and Japanese stereo.
- TorrentsCSV: EMBER S01 1080p dual-audio pack,75 reported seeds; the title alone
 does not prove the languages. Installed picker marked it fits=true for S1E1.
- APiBay: title explicitly says English Dub1080p Season1,1 reported seed; picker
 fit=false, needs parser/identity/coordinate diagnosis rather than bypassing gates.
- AnimeTosho: S01 dual release and later-season explicitly English-dubbed releases;
 its broad query also returned other seasons, so matching title text is not scope proof.

These are listing counts and uploader claims, NOT real swarm or content verification.
v0.4.1 simulated38-case suite missed actual source-detail/category evidence and
real multi-title/season-pack release names. Generic MULTi is only ranked fallback,
but that still permits French/Japanese. Japanese last resort does not authorize
arbitrary unverified non-English fallback. Additional regression repair remains open.
Need reproduce actual names, inspect broad-vs-coordinate query recall, alias/pack
identity filtering, provider detail evidence, known bad owned-source exclusion and
partial/post-download evidence handling before another audio release claim.

Deletion plan remains separately authorized; no deletion product changes yet at the
time of this note. Do not lose either repair across context changes.
