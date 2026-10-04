import { useTitleDetailQuery } from "./use-title-detail-query";
import { useTitleDetailActions } from "./use-title-detail-actions";
import { useSeasonGrab } from "./use-season-grab";
import type { TitleDetailProps } from "./title-props";

export function useTitleDetail(props: TitleDetailProps) {
  const query = useTitleDetailQuery(props);
  const actions = useTitleDetailActions(query);
  const seasonGrab = useSeasonGrab(query);
  return { ...query, ...actions, ...seasonGrab };
}
