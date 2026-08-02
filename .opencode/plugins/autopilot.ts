/**
 * Autopilot: on idle, hand back the next item the database says is outstanding.
 *
 * Armed with a file rather than a config flag, so it can be switched off from
 * outside the session — including by someone who is not the agent:
 *
 *   node scripts/autopilot.mjs on 40    # run at most 40 more steps
 *   node scripts/autopilot.mjs off
 *   node scripts/autopilot.mjs status
 *
 * Two safety properties matter more than the automation itself.
 *
 * First, the next step comes from `plan.mjs next`, which reads verified state.
 * An agent left to choose its own next task from memory drifts toward what it
 * remembers finishing and away from what it only believes it finished — this
 * repository has three sessions of evidence for that, including eleven ticked
 * Phase 1A items of which one had no implementation at all.
 *
 * Second, there is a hard step budget that only decrements. A loop that can
 * refill its own budget is not a budget. When it reaches zero the plugin stops
 * prompting and says so, rather than quietly continuing.
 *
 * What this deliberately does NOT do is mark anything complete. Completion is
 * still written by `plan.mjs mark`, which demands evidence. Automating the
 * request for work is safe; automating the claim that work is finished would
 * reproduce exactly the failure this whole exercise exists to correct.
 */
import type { Plugin } from "@opencode-ai/plugin";

const STATE_FILE = "docs/.autopilot.json";

type State = { armed: boolean; budget: number };

export const Autopilot: Plugin = async ({ client, $, directory }) => {
  const read = async (): Promise<State> => {
    try {
      const text = await $`cat ${STATE_FILE}`.cwd(directory).text();
      const parsed = JSON.parse(text) as Partial<State>;
      return { armed: Boolean(parsed.armed), budget: Number(parsed.budget ?? 0) };
    } catch {
      return { armed: false, budget: 0 };
    }
  };

  const log = (message: string, extra?: Record<string, unknown>) =>
    client.app
      .log({ body: { service: "autopilot", level: "info", message, extra } })
      .catch(() => {});

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const state = await read();
      if (!state.armed) return;

      if (state.budget <= 0) {
        await log("budget exhausted; not prompting");
        await client.tui
          .showToast({
            body: {
              message: "Autopilot budget exhausted — re-arm to continue",
              variant: "warning",
            },
          })
          .catch(() => {});
        return;
      }

      // Spend the step before asking for it. If the prompt fails, the budget
      // is still down one — an autopilot that only pays for successful turns
      // can spin indefinitely on a failing step.
      await $`node scripts/autopilot.mjs spend`.cwd(directory).quiet().nothrow();

      const next = await $`node --experimental-sqlite scripts/plan.mjs next`
        .cwd(directory)
        .text()
        .catch(() => "");

      if (!next.trim() || next.includes("PLAN COMPLETE")) {
        await $`node scripts/autopilot.mjs off`.cwd(directory).quiet().nothrow();
        await log("plan complete; disarming");
        return;
      }

      await log("continuing", { budget: state.budget - 1 });

      await client.tui
        .appendPrompt({
          body: {
            text: [
              "Continue autonomously. The next outstanding item is:",
              "",
              next.trim(),
              "",
              "Rules that still apply:",
              "- Verify before you build. A tick in the plan is not evidence.",
              "- Any new assertion must be observed failing before it is trusted.",
              "- Record the result with: node --experimental-sqlite scripts/plan.mjs mark <phase:line> <state> \"<evidence>\"",
              "- Do not mark anything done on the strength of your own summary.",
              "- Commit and push each logical chunk.",
            ].join("\n"),
          },
        })
        .catch(async (error: unknown) => {
          await log("could not append prompt", { error: String(error) });
        });
    },
  };
};
