/**
 * Facts for non-video releases — pinned against real indexer titles.
 *
 * Every "real" case below was returned by the live aggregator during this work,
 * not invented. That matters: the failure mode for this module is not a crash,
 * it is a row that looks informative and says something untrue, and only real
 * names carry the ambiguities that produce it (an audiobook that mentions
 * "epub", an album by a band whose name contains "Mac").
 *
 * The rule class these defend, in priority order:
 *
 *   1. **Never state a fact that is not in the title.** An omitted fact is a
 *      correct answer; a guessed one is a lie the owner acts on.
 *   2. **Never mislabel a format.** Format is the entire decision for music and
 *      books — FLAC vs MP3, ebook vs 12-hour audiobook.
 *   3. **Never let video vocabulary leak in.** No resolution, no episode, no
 *      source tier: an album has none of those.
 *
 * Run: npx tsx src/components/search/artifact-facts.test.ts
 */
import assert from "node:assert/strict";
import {
  artifactActionName,
  artifactFacts,
  formatLabel,
  platformLabel,
  versionLabel,
  yearLabel,
} from "./artifact-facts";

let failures = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function main() {
  console.log("artifact-facts.test.ts");

  // ── Format: the fact the whole choice turns on ───────────────────────────
  const formats: Array<{ title: string; expect: string | null; why: string }> = [
    {
      title: "Daft Punk - Discovery (2001) [FLAC] 88",
      expect: "FLAC",
      why: "real result; lossless is why you'd pick it",
    },
    {
      title: "Daft Punk - Discovery (2001) Mp3 320kbps [PMEDIA] ⭐️",
      expect: "MP3",
      why: "real result",
    },
    {
      title: "Some Album [24-bit Hi-Res]",
      expect: "FLAC",
      why: "hi-res is lossless family",
    },
    {
      title: "Artist - Album (FLAC + MP3)",
      expect: "FLAC",
      why: "a bundle is worth picking FOR the lossless copy",
    },
    {
      title: "Brandon Sanderson - Mistborn Series 1-6(EPUB)",
      expect: "EPUB",
      why: "real result",
    },
    {
      title: "Atomic Habits - James Clear (Unabridged)",
      expect: "Audiobook",
      why: "real result; unabridged means a listen",
    },
    {
      title: "Atomic Habits - James Clear - 2018 (miok) [Audiobook] (Self-Help)",
      expect: "Audiobook",
      why: "real result",
    },
    {
      // The trap: audiobook releases bundle a companion epub constantly.
      // Calling a 12-hour listen an "EPUB" is the worst outcome here.
      title: "Some Book [Audiobook + EPUB]",
      expect: "Audiobook",
      why: "audiobook must win over the bundled text",
    },
    {
      title: "Stardew Valley [FitGirl Repack]",
      expect: "Repack",
      why: "real result",
    },
    {
      title: "stardew_valley_windows_gog_(78674)",
      expect: "GOG",
      why: "real result; DRM-free is the differentiator",
    },
    {
      title: "Blender 2.8 addons pack 2.8-2.91.2 [ENG]",
      expect: null,
      why: "real result; states no format, so say none",
    },
    {
      title: "A Perfectly Ordinary Release Name",
      expect: null,
      why: "nothing stated, nothing invented",
    },
  ];
  for (const row of formats) {
    check(`format: ${row.title.slice(0, 46)} → ${row.expect ?? "none"}`, () => {
      assert.equal(formatLabel(row.title), row.expect, row.why);
    });
  }

  // ── Platform: only from unambiguous markers ──────────────────────────────
  const platforms: Array<{ title: string; expect: string | null; why: string }> = [
    { title: "Adobe Photoshop 2024 (macOS)", expect: "macOS", why: "explicit" },
    { title: "Some Tool v3 win64", expect: "Windows", why: "explicit" },
    { title: "App 1.2 AppImage", expect: "Linux", why: "explicit" },
    { title: "Zelda TOTK NSP", expect: "Switch", why: "explicit" },
    {
      // The reason bare "Mac" is not a pattern. This is a rapper, not macOS.
      title: "Mac Miller - Swimming (2018) [FLAC]",
      expect: null,
      why: "an artist name must never become a platform",
    },
    {
      title: "Macbeth (2015) 1080p",
      expect: null,
      why: "a word containing 'mac' is not macOS",
    },
    { title: "Ordinary Album Name", expect: null, why: "nothing stated" },
  ];
  for (const row of platforms) {
    check(`platform: ${row.title.slice(0, 42)} → ${row.expect ?? "none"}`, () => {
      assert.equal(platformLabel(row.title), row.expect, row.why);
    });
  }

  // ── Version vs year: never confuse the two ───────────────────────────────
  check("a v-prefixed build is a version", () => {
    assert.equal(versionLabel("Some App v3.1.4 x64"), "v3.1.4");
  });
  check("a dotted build with no prefix is still a version", () => {
    assert.equal(versionLabel("Blender 2.91.2"), "v2.91.2");
  });
  check("a bare year is NOT a version", () => {
    assert.equal(versionLabel("Album Name (2001)"), null);
  });
  check("an audio channel layout is NOT a version", () => {
    // Caught rendering live: "Daft Punk - Discovery - 5.1 Surround Sound" put
    // "v5.1" on an album row. Albums do not have builds.
    assert.equal(versionLabel("Daft Punk - Discovery - 5.1 Surround Sound"), null);
    for (const layout of ["2.0", "2.1", "5.1", "7.1"]) {
      assert.equal(versionLabel(`Some Album ${layout} Mix`), null, layout);
    }
    // But an explicitly v-prefixed one is still a version — the exclusion is
    // about bare dotted pairs, not about the digits themselves.
    assert.equal(versionLabel("Some App v5.1 x64"), null, "v5.1 is still a layout shape");
    assert.equal(versionLabel("Some App v5.1.2 x64"), "v5.1.2", "a three-part build is unambiguous");
  });
  check("an absurdly long build string is dropped, not printed", () => {
    assert.equal(versionLabel("Tool v1.2.3.4567890123456"), null);
  });
  check("a year is read when present", () => {
    assert.equal(yearLabel("Daft Punk - Discovery (2001) [FLAC]"), "2001");
  });
  check("a bitrate is never mistaken for a year", () => {
    assert.equal(yearLabel("Album Mp3 320kbps"), null);
  });

  // ── The row: honest, bounded, and free of video vocabulary ───────────────
  check("a real FLAC album reads format · year · size", () => {
    const facts = artifactFacts("Daft Punk - Discovery (2001) [FLAC] 88", "1.2 GB");
    assert.deepEqual(facts, ["FLAC", "2001", "1.2 GB"]);
  });

  check("a real repack reads format · size and invents nothing else", () => {
    const facts = artifactFacts("Stardew Valley [FitGirl Repack]", "512 MB");
    assert.deepEqual(facts, ["Repack", "512 MB"]);
  });

  check("a title stating nothing yields size alone, not placeholders", () => {
    const facts = artifactFacts("Blender 2.8 addons pack", "88 MB");
    // A version IS stated here (2.8), so that plus size is the honest answer.
    assert.ok(facts.includes("88 MB"));
    assert.ok(
      facts.every((f) => f.trim().length > 0 && !/^[-–—?]$/.test(f)),
      `no placeholder dashes: ${JSON.stringify(facts)}`,
    );
  });

  check("a bare title with no size yields an empty list, not ['']", () => {
    assert.deepEqual(artifactFacts("Untitled Thing", null), []);
  });

  check("a row never shows more than three facts", () => {
    // Everything at once: format, platform, version, year and size all present.
    const facts = artifactFacts(
      "Adobe Photoshop 2024 v25.5.1 macOS Portable ISO",
      "3.4 GB",
    );
    assert.ok(facts.length <= 3, `got ${facts.length}: ${JSON.stringify(facts)}`);
  });

  check("video vocabulary never appears on an artifact row", () => {
    // The regression that matters: reusing the video fact builder here would
    // put "1080p · WEB-DL" on an album. Even a title carrying those words must
    // not surface them through THIS module.
    const facts = artifactFacts(
      "Some Concert Film 1080p WEB-DL S01E02 [FLAC]",
      "2 GB",
    );
    const joined = facts.join(" ");
    assert.doesNotMatch(joined, /1080p|720p|WEB-DL|S\d{2}E\d{2}/i, joined);
  });

  check("the accessible action name identifies WHICH release", () => {
    // Two rows both labelled "Download" are unusable with a screen reader.
    const a = artifactActionName("Daft Punk - Discovery [FLAC]", "1.2 GB");
    const b = artifactActionName("Daft Punk - Discovery [MP3]", "320 MB");
    assert.notEqual(a, b);
    assert.ok(a.includes("Daft Punk"));
    assert.ok(a.includes("FLAC"));
  });

  check("the action name survives a title with no readable facts", () => {
    const name = artifactActionName("Untitled Thing", null);
    assert.equal(name, "Untitled Thing");
    assert.doesNotMatch(name, /undefined|null|—\s*$/);
  });

  // ── Underscore separators: a whole class, not one title ──────────────────
  //
  // `\b` counts `_` as a word character, so every pattern silently missed on
  // underscore-separated names — a routine shape from several indexers. Found
  // by a real result (`stardew_valley_windows_gog_(78674)`) whose GOG marker
  // vanished. Pinned across every fact so the normalisation cannot be dropped
  // from one of them later.
  const underscored: Array<{ title: string; check: () => void; name: string }> = [
    {
      name: "format survives underscores",
      title: "stardew_valley_windows_gog_(78674)",
      check: () => assert.equal(formatLabel("stardew_valley_windows_gog_(78674)"), "GOG"),
    },
    {
      name: "platform survives underscores",
      title: "stardew_valley_windows_gog_(78674)",
      check: () =>
        assert.equal(platformLabel("stardew_valley_windows_gog_(78674)"), "Windows"),
    },
    {
      name: "audio format survives underscores",
      title: "some_artist_album_2001_flac",
      check: () => assert.equal(formatLabel("some_artist_album_2001_flac"), "FLAC"),
    },
    {
      name: "year survives underscores",
      title: "some_artist_album_2001_flac",
      check: () => assert.equal(yearLabel("some_artist_album_2001_flac"), "2001"),
    },
    {
      name: "version survives underscores",
      title: "some_tool_v3.1.4_x64",
      check: () => assert.equal(versionLabel("some_tool_v3.1.4_x64"), "v3.1.4"),
    },
  ];
  for (const row of underscored) {
    check(row.name, row.check);
  }

  check("the underscore fix did not loosen ordinary boundaries", () => {
    // Normalising separators must not turn substrings into matches: "gogo" is
    // not GOG, and "flackery" is not FLAC.
    assert.equal(formatLabel("Gogol Bordello - Live"), null);
    assert.equal(formatLabel("The Flack Sessions"), null);
    assert.equal(platformLabel("Windowsill - EP"), null);
  });

  if (failures > 0) {
    console.error(`artifact-facts.test.ts: ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("artifact-facts.test.ts: all assertions passed");
}

main();
