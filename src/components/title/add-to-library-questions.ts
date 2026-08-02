/**
 * What we ask when a title joins the library, and what those answers mean.
 *
 * Adding a title is the one moment the app has the user's attention and does
 * not yet know what they want. Every question skipped here becomes a setting
 * they have to go find later, and every question asked here that does not
 * change what happens is a tax on the common case. So the bar for asking is
 * narrow: a question earns its place only if the two answers lead to visibly
 * different behaviour.
 *
 * That bar rules out most of what the *arr onboarding asks. Quality is not a
 * question — there is a global preference and it is almost always right, so it
 * is *disclosed* with a way to change it rather than demanded. Season is a
 * question, because for a show with eight aired seasons the two sensible
 * answers differ by two hundred episodes.
 *
 * The invariant that shapes the defaults: adding a title never downloads
 * anything, and turning on automation later must never reach backwards. A
 * start point of "from the beginning" combined with a monitor toggle flipped a
 * week later would otherwise fetch a decade of television because of a choice
 * the user made in a different context and has forgotten.
 */

/** What the title page knows when the add control is pressed. */
export interface AddSubject {
  /** Does this work have seasons at all? */
  isSeries: boolean;
  /** Season numbers the provider knows about, ascending. Empty when unknown. */
  seasons: number[];
  /** `YYYY-MM-DD`, or null when the provider has no date. */
  releaseDate: string | null;
}

export type StartPoint =
  /** Only things that air from now on. */
  | { kind: "now" }
  /** Everything, oldest first. */
  | { kind: "beginning" }
  /** A specific season onwards. */
  | { kind: "season"; season: number };

export interface AddAnswers {
  startPoint: StartPoint;
  /** Hunt for new material without being asked again. */
  autoDownload: boolean;
  /** Null means "use whatever the global preference is". */
  preferredResolution: number | null;
}

export type QuestionId = "start-point" | "auto-download";

export interface AddQuestion {
  id: QuestionId;
  /** The question as a person would ask it. */
  prompt: string;
  options: { value: string; label: string; hint?: string }[];
}

/** A date in the future means nothing can be acquired yet. */
export function isUnreleased(
  releaseDate: string | null,
  now: Date = new Date(),
): boolean {
  if (!releaseDate) return false;
  const at = Date.parse(releaseDate);
  if (Number.isNaN(at)) return false;
  return at > now.getTime();
}

/**
 * The questions worth asking for this subject, in order.
 *
 * A film gets no season question because it has no seasons, and a film already
 * in cinemas gets no monitoring question either: monitoring an available film
 * is a loop that fires once and does what pressing Download would have done.
 * Asking it would imply a difference that does not exist.
 */
export function addQuestions(subject: AddSubject): AddQuestion[] {
  if (!subject.isSeries) {
    if (!isUnreleased(subject.releaseDate)) return [];
    return [
      {
        id: "auto-download",
        prompt: "This is not out yet. Grab it when it lands?",
        options: [
          { value: "yes", label: "Yes, get it automatically" },
          { value: "no", label: "No, I'll decide later" },
        ],
      },
    ];
  }

  const seasonOptions = subject.seasons.map((season) => ({
    value: `season:${season}`,
    label: `From season ${season}`,
  }));

  return [
    {
      id: "start-point",
      prompt: "Where should this start?",
      options: [
        {
          value: "now",
          label: "New episodes only",
          hint: "Nothing already aired",
        },
        {
          value: "beginning",
          label: "From the beginning",
          hint: seasonOptions.length
            ? `All ${seasonOptions.length} seasons`
            : undefined,
        },
        ...seasonOptions,
      ],
    },
    {
      id: "auto-download",
      prompt: "Download episodes as they appear?",
      options: [
        { value: "yes", label: "Yes, keep it current" },
        { value: "no", label: "No, I'll pick them myself" },
      ],
    },
  ];
}

/**
 * The answers used when the user adds without opening the questions.
 *
 * `autoDownload` is false and the start point is "now" for the same reason:
 * the quiet path must not start a download. A default of "beginning" would be
 * harmless on its own and catastrophic the moment monitoring is switched on,
 * and by then the connection between the two is invisible.
 */
export function defaultAnswers(): AddAnswers {
  return {
    startPoint: { kind: "now" },
    autoDownload: false,
    preferredResolution: null,
  };
}

export function parseStartPoint(value: string): StartPoint | null {
  if (value === "now") return { kind: "now" };
  if (value === "beginning") return { kind: "beginning" };
  const match = /^season:(\d+)$/.exec(value);
  if (!match) return null;
  const season = Number(match[1]);
  if (!Number.isInteger(season) || season < 1) return null;
  return { kind: "season", season };
}

export interface AddPayloadFields {
  monitored: boolean;
  fromSeason: number | null;
  fromEpisode: number | null;
  preferredResolution: number | null;
}

/**
 * Turn answers into the fields `POST /api/watchlist` understands.
 *
 * "New episodes only" deliberately sends no season. A season is an instruction
 * to go back and fill in from there, so sending season 1 to mean "start now"
 * would say the opposite of what was chosen. The absence is the answer.
 */
export function answersToPayload(answers: AddAnswers): AddPayloadFields {
  const base = {
    monitored: answers.autoDownload,
    preferredResolution: answers.preferredResolution,
  };
  if (answers.startPoint.kind === "beginning") {
    return { ...base, fromSeason: 1, fromEpisode: 1 };
  }
  if (answers.startPoint.kind === "season") {
    return { ...base, fromSeason: answers.startPoint.season, fromEpisode: 1 };
  }
  return { ...base, fromSeason: null, fromEpisode: null };
}

/**
 * One line stating what pressing Add will actually do.
 *
 * Written because a dialog of controls describes its own settings rather than
 * their consequence, and "monitored: true, fromSeason: 1" is a description of
 * a database row, not of the two hundred files about to arrive.
 */
export function addSummary(
  subject: AddSubject,
  answers: AddAnswers,
): string {
  if (!subject.isSeries) {
    return answers.autoDownload
      ? "Added, and downloaded automatically when it is released."
      : "Added to your library. Nothing is downloaded.";
  }
  if (!answers.autoDownload) {
    return "Added to your library. Nothing is downloaded until you ask.";
  }
  if (answers.startPoint.kind === "now") {
    return "New episodes will be downloaded as they air.";
  }
  const from =
    answers.startPoint.kind === "beginning"
      ? "the first episode"
      : `season ${answers.startPoint.season}`;
  return `Downloading from ${from} onwards, then keeping up with new episodes.`;
}
