import path from "node:path";
import {
  isInsideRoot,
  isWithinLibrary,
  libraryRoots,
} from "./path-containment";

let failures = 0;

function assert(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const win = process.platform === "win32";
/** Build a platform-native absolute path so the suite runs on Windows and Linux. */
const abs = (...parts: string[]) =>
  win ? path.join("D:\\", ...parts) : path.join("/", ...parts);

// --- isInsideRoot --------------------------------------------------------
const insideCases: [string, string, boolean, string][] = [
  [abs("media"), abs("media"), true, "a root contains itself"],
  [abs("media", "Anime"), abs("media"), true, "a direct child is inside"],
  [
    abs("media", "Anime", "Show", "Season 01"),
    abs("media"),
    true,
    "a deep descendant is inside",
  ],
  [abs("media-secret"), abs("media"), false, "a sibling sharing a prefix is not inside"],
  [abs("media2"), abs("media"), false, "a name extension is not inside"],
  [abs("other"), abs("media"), false, "an unrelated tree is not inside"],
  [abs("media", "..", "etc"), abs("media"), false, "traversal cannot escape"],
  [
    abs("media", "Anime", "..", "..", "Windows"),
    abs("media"),
    false,
    "stacked traversal cannot escape",
  ],
  [abs(), abs("media"), false, "the filesystem root is not inside a subfolder"],
  [abs("media", "a b c"), abs("media"), true, "spaces are handled"],
];

for (const [target, root, expected, name] of insideCases) {
  assert(name, isInsideRoot(target, root) === expected, `${target} vs ${root}`);
}

if (win) {
  assert(
    "Windows comparison ignores case",
    isInsideRoot("D:\\MEDIA\\Anime", "d:\\media"),
  );
  assert(
    "forward slashes normalise on Windows",
    isInsideRoot("D:/media/Anime", "D:\\media"),
  );
}

// --- libraryRoots --------------------------------------------------------
assert(
  "collects base, save and per-category paths",
  libraryRoots({
    baseDownloadPath: abs("media"),
    savePath: abs("incoming"),
    pathRules: { Anime: abs("anime"), Movies: abs("films") },
  }).length === 4,
);

assert(
  "ignores blank and whitespace-only entries",
  libraryRoots({
    baseDownloadPath: abs("media"),
    savePath: "   ",
    pathRules: { Anime: "", Movies: null as unknown as string },
  }).length === 1,
);

assert(
  "de-duplicates roots that resolve to the same folder",
  libraryRoots({
    baseDownloadPath: abs("media"),
    savePath: abs("media"),
    pathRules: { Anime: abs("media", "Anime", "..") },
  }).length === 1,
);

assert(
  "an unconfigured client has no roots",
  libraryRoots({ baseDownloadPath: null, savePath: null, pathRules: null })
    .length === 0,
);

// --- isWithinLibrary -----------------------------------------------------
const roots = libraryRoots({
  baseDownloadPath: abs("media"),
  savePath: null,
  pathRules: { Anime: abs("anime") },
});

assert("a path under the base root passes", isWithinLibrary(abs("media", "x"), roots));
assert(
  "a path under a per-category root passes",
  isWithinLibrary(abs("anime", "Show"), roots),
);
assert("an outside path is rejected", isWithinLibrary(abs("Windows"), roots) === false);
assert(
  "nothing is within an empty library",
  isWithinLibrary(abs("media"), []) === false,
);

console.log(
  failures === 0 ? "\nPASS path-containment" : `\nFAIL path-containment (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
