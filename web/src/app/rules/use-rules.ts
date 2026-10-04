import { useCallback, useState } from "react";
import { useApiQuery } from "@/hooks/use-api-query";
import { send } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  buildRuleCreatePayload,
  buildRuleFilterPayload,
  type RuleFormState,
  type RuleFilterFormState,
} from "@/lib/rules/form";
import type { Rule } from "./rule-types";

interface RuleListResponse {
  rules?: Rule[];
}

export function useRules() {
  const query = useApiQuery<Rule[]>("/api/rules", {
    select: (json) => (json as RuleListResponse | null)?.rules ?? [],
  });
  const [running, setRunning] = useState(false);
  const [mutating, setMutating] = useState(false);

  const mutate = useCallback(async (body: unknown, method = "PATCH") => {
    setMutating(true);
    try {
      const response = await send("/api/rules", { method, body });
      if (!response.ok) throw response.error ?? new Error("Could not update rule.");
      query.refetch();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update rule.");
      return false;
    } finally {
      setMutating(false);
    }
  }, [query.refetch]);

  const create = useCallback(async (form: RuleFormState) => {
    const created = await mutate(buildRuleCreatePayload(form), "POST");
    if (created) toast.success("Rule created");
    return created;
  }, [mutate]);

  const update = useCallback(async (id: string, form: RuleFormState) => {
    const saved = await mutate({ id, ...buildRuleCreatePayload(form) });
    if (saved) toast.success("Rule saved");
    return saved;
  }, [mutate]);

  const toggle = useCallback((id: string, enabled: boolean) =>
    mutate({ id, enabled }), [mutate]);

  const retarget = useCallback((id: string, category: string) =>
    mutate({ id, category }), [mutate]);

  const saveFilters = useCallback((id: string, filters: RuleFilterFormState) =>
    mutate(buildRuleFilterPayload(id, filters)), [mutate]);

  const remove = useCallback(async (id: string) => {
    setMutating(true);
    try {
      const response = await send(`/api/rules?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw response.error ?? new Error("Could not delete rule.");
      query.refetch();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete rule.");
      return false;
    } finally {
      setMutating(false);
    }
  }, [query.refetch]);

  const removeMany = useCallback(async (ids: string[]) => {
    const results = await Promise.all(ids.map(remove));
    const deleted = results.filter(Boolean).length;
    if (deleted) toast.success(`${deleted} ${deleted === 1 ? "rule" : "rules"} deleted`);
    if (deleted !== ids.length) {
      throw new Error(`Could not delete ${ids.length - deleted} rules. The list has been refreshed.`);
    }
  }, [remove]);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const response = await send<Record<string, unknown>>("/api/rules/run", {
        method: "POST",
      });
      const result = response.data;
      if (!response.ok || result?.ok === false) {
        throw response.error ?? new Error(
          typeof result?.message === "string" ? result.message : "Could not run rules.",
        );
      }
      toast.success(typeof result?.message === "string" ? result.message : "Rules run complete");
      query.refetch();
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not run rules.");
      return false;
    } finally {
      setRunning(false);
    }
  }, [query.refetch]);

  return {
    rules: query.data ?? [],
    query,
    running,
    mutating,
    create,
    update,
    toggle,
    retarget,
    saveFilters,
    remove,
    removeMany,
    run,
  };
}
