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
 * Adding always enables tracking and automatic downloads. The only remaining
 * decision is how far back a series should start.
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
  /** Null means "use whatever the global preference is". */
  preferredResolution: number | null;
}

export type QuestionId = "start-point";

export interface AddQuestion {
  id: QuestionId;
  /** The question as a person would ask it. */
  prompt: string;
  options: { value: string; label: string; hint?: string }[];
}

/**
 * The questions worth asking for this subject, in order.
 *
 * A film gets no season question because it has no seasons. Monitoring is
 * implied by adding any title, so it is never presented as a choice.
 */
export function addQuestions(subject: AddSubject): AddQuestion[] {
  if (!subject.isSeries) return [];

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
  ];
}

/**
 * The answers used when the user adds without opening the questions.
 *
 * "New episodes only" is the conservative series default. Films do not use a
 * start point, but share this shape so they can take the direct add path.
 */
export function defaultAnswers(): AddAnswers {
  return {
    startPoint: { kind: "now" },
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
    monitored: true,
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
    return "Adding keeps this movie in your library and gets it when available.";
  }
  if (answers.startPoint.kind === "now") {
    return "Adding keeps this series in your library and gets new episodes as they air.";
  }
  const from =
    answers.startPoint.kind === "beginning"
      ? "the first episode"
      : `season ${answers.startPoint.season}`;
  return `Adding gets episodes from ${from} onwards and keeps up with new episodes.`;
}
