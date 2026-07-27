import {
  formatSaveLocation,
  historyMessageFromFacts,
  parseHistoryFacts,
} from "./history";

let failures = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const legacyCases = [
  {
    name: "automation history with category and path",
    row: {
      message:
        "On-demand S01E01 · Download started (0% · 2 peers) · cat=TV · path=D:\\code\\torrent-aggregator\\.e2e-instant-play\\ikhdckff\\leech\\TV\\",
    },
    expect: {
      context: "On-demand S01E01",
      message: "Download started (0% · 2 peers)",
      category: "TV",
      savePath:
        "D:\\code\\torrent-aggregator\\.e2e-instant-play\\ikhdckff\\leech\\TV\\",
    },
  },
  {
    name: "manual send with client facts",
    row: {
      message:
        "Downloading in built-in engine (0% · 5 peers) · via=builtin · kind=movie · cat=Movies · path=D:\\Media\\Movies",
    },
    expect: {
      context: null,
      message: "Downloading in built-in engine (0% · 5 peers)",
      category: "Movies",
      savePath: "D:\\Media\\Movies",
      clientType: "builtin",
      sendKind: "movie",
    },
  },
  {
    name: "new structured row leaves clean prose alone",
    row: {
      message: "Download started (0% · 2 peers)",
      category: "TV",
      savePath: "D:\\Media\\TV",
      clientType: "builtin",
      sendKind: "episode",
    },
    expect: {
      context: null,
      message: "Download started (0% · 2 peers)",
      category: "TV",
      savePath: "D:\\Media\\TV",
      clientType: "builtin",
      sendKind: "episode",
    },
  },
];

for (const tc of legacyCases) {
  const got = parseHistoryFacts(tc.row);
  for (const [key, expected] of Object.entries(tc.expect)) {
    check(
      `${tc.name}: ${key}`,
      got[key as keyof typeof got] === expected,
      `got ${got[key as keyof typeof got]}`,
    );
  }
}

check(
  "producer persists prose only, not key=value facts",
  historyMessageFromFacts({
    message: "Download started (0% · 2 peers)",
    category: "TV",
    savePath: "D:\\Media\\TV",
  }) === "Download started (0% · 2 peers)",
);

const locationCases = [
  {
    name: "normal download root",
    path: "D:\\Media\\downloads\\TV\\The Boys\\Season 01",
    category: "TV",
    expected: "TV\\The Boys\\Season 01",
  },
  {
    name: "test harness root",
    path: "D:\\code\\torrent-aggregator\\.e2e-instant-play\\ikhdckff\\leech\\TV\\",
    category: "TV",
    expected: "TV",
  },
  {
    name: "unknown absolute path is shortened",
    path: "D:\\long\\private\\path\\Movies\\Film",
    category: null,
    expected: "path\\Movies\\Film",
  },
];

for (const tc of locationCases) {
  const got = formatSaveLocation(tc.path, tc.category);
  check(`${tc.name}: display location`, got === tc.expected, `got ${got}`);
  check(`${tc.name}: no drive letter inline`, !/^[A-Z]:\\/i.test(got ?? ""));
}

console.log(failures === 0 ? "\nPASS history facts" : `\nFAIL history facts (${failures})`);
process.exit(failures === 0 ? 0 : 1);
