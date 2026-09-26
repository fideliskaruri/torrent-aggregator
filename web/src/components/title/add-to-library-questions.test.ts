/**
 * What we ask when a title joins the library.
 *
 * Run: npx tsx src/components/title/add-to-library-questions.test.ts
 *
 * The cases that matter are the ones where a reasonable-looking default is
 * dangerous: a start point that reaches backwards, a question asked about a
 * film that has no seasons, or an answer that turns into a payload meaning the
 * opposite of what was clicked.
 */
import assert from "node:assert/strict";
import {
  addQuestions,
  addSummary,
  answersToPayload,
  defaultAnswers,
  parseStartPoint,
  type AddSubject,
} from "./add-to-library-questions";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${(error as Error).message}`);
  }
}

const series = (over: Partial<AddSubject> = {}): AddSubject => ({
  isSeries: true,
  seasons: [1, 2, 3],
  releaseDate: "2019-04-01",
  ...over,
});
const film = (over: Partial<AddSubject> = {}): AddSubject => ({
  isSeries: false,
  seasons: [],
  releaseDate: "2021-10-22",
  ...over,
});

check("a film is never asked which season to start from", () => {
  const ids = addQuestions(film()).map((q) => q.id);
  assert.ok(
    !ids.includes("start-point"),
    `a film has no seasons to choose between, got ${JSON.stringify(ids)}`,
  );
});

check("a film already out is not asked anything at all", () => {
  // Monitoring an available film fires once and does what Download does.
  // Offering it as a choice implies a difference that does not exist.
  assert.deepEqual(addQuestions(film({ releaseDate: "2001-01-01" })), []);
});

check("a film not yet out is also added without a preference question", () => {
  const soon = new Date(Date.now() + 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  assert.deepEqual(addQuestions(film({ releaseDate: soon })), []);
});

check("a film with no known date is not asked anything", () => {
  assert.deepEqual(addQuestions(film({ releaseDate: null })), []);
});

check("a series is asked where to start, and every known season is offered", () => {
  const questions = addQuestions(series({ seasons: [1, 2, 3, 4] }));
  assert.equal(questions.length, 1);
  const [first] = questions;
  assert.equal(first.id, "start-point");
  const values = first.options.map((o) => o.value);
  assert.deepEqual(values, [
    "now",
    "beginning",
    "season:1",
    "season:2",
    "season:3",
    "season:4",
  ]);
});

check("a series with unknown seasons still gets a usable choice", () => {
  const [first] = addQuestions(series({ seasons: [] }));
  assert.deepEqual(
    first.options.map((o) => o.value),
    ["now", "beginning"],
    "we cannot list seasons we do not know, but the two ends are always real",
  );
});

check("quality is never a question", () => {
  // There is a global preference and it is nearly always right. Asking makes
  // the common path longer to reach the same answer.
  for (const subject of [series(), film(), film({ releaseDate: null })]) {
    const ids = addQuestions(subject).map((q) => String(q.id));
    assert.ok(
      !ids.some((id) => id.includes("quality") || id.includes("resolution")),
      `got ${JSON.stringify(ids)}`,
    );
  }
});

check("the default starts a series with new episodes", () => {
  const answers = defaultAnswers();
  assert.equal(
    answers.startPoint.kind,
    "now",
    "adding should not unexpectedly backfill old seasons",
  );
  assert.equal(answersToPayload(answers).monitored, true);
});

check("'new episodes only' sends no season, because absence is the answer", () => {
  const payload = answersToPayload({
    startPoint: { kind: "now" },
    preferredResolution: null,
  });
  assert.equal(
    payload.fromSeason,
    null,
    "a season is an instruction to fill in from there; sending 1 would say " +
      "the opposite of what was chosen",
  );
  assert.equal(payload.fromEpisode, null);
  assert.equal(payload.monitored, true);
});

check("'from the beginning' starts at the first episode of the first season", () => {
  const payload = answersToPayload({
    startPoint: { kind: "beginning" },
    preferredResolution: 1080,
  });
  assert.equal(payload.fromSeason, 1);
  assert.equal(payload.fromEpisode, 1);
  assert.equal(payload.preferredResolution, 1080);
});

check("a chosen season starts at that season's first episode", () => {
  const payload = answersToPayload({
    startPoint: { kind: "season", season: 4 },
    preferredResolution: null,
  });
  assert.equal(payload.fromSeason, 4);
  assert.equal(payload.fromEpisode, 1);
  assert.equal(payload.monitored, true);
});

check("choosing a season always keeps tracking enabled", () => {
  const payload = answersToPayload({
    startPoint: { kind: "season", season: 2 },
    preferredResolution: null,
  });
  assert.equal(payload.monitored, true);
});

check("a null resolution means the global preference, not a magic number", () => {
  const payload = answersToPayload(defaultAnswers());
  assert.equal(
    payload.preferredResolution,
    null,
    "baking 1080 in here would freeze a copy of the setting at add time",
  );
});

check("start points survive a round trip through their form values", () => {
  assert.deepEqual(parseStartPoint("now"), { kind: "now" });
  assert.deepEqual(parseStartPoint("beginning"), { kind: "beginning" });
  assert.deepEqual(parseStartPoint("season:12"), { kind: "season", season: 12 });
});

check("junk start points are rejected rather than guessed at", () => {
  for (const bad of ["", "season:", "season:0", "season:-1", "season:x", "S01"]) {
    assert.equal(parseStartPoint(bad), null, `expected null for ${bad || "''"}`);
  }
});

check("the summary simply states what adding does", () => {
  const current = addSummary(series(), defaultAnswers());
  assert.match(current, /new episodes as they air/i);
  const backfill = addSummary(series(), {
    startPoint: { kind: "beginning" },
    preferredResolution: null,
  });
  assert.match(backfill, /first episode/i);
  assert.ok(
    !/monitored|fromSeason/i.test(backfill),
    "a row description is not a consequence",
  );
  const movie = addSummary(film(), defaultAnswers());
  assert.match(movie, /gets it when available/i);
  assert.ok(!/engine|torrent|monitored|fromSeason/i.test(movie));
});

if (failures) {
  console.error(`\n${failures} card question test(s) failed.`);
  process.exit(1);
}
console.log("\nAll add-to-library question tests passed.");
