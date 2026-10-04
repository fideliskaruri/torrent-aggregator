import { useTitleContentState } from "./use-title-content-state";
import { useTitleContentViewModel } from "./use-title-content-view-model";

export function useTitleContentModel(props: Parameters<typeof useTitleContentState>[0]) {
  const state = useTitleContentState(props);
  return useTitleContentViewModel(state);
}

export type TitleContentProps = Parameters<typeof useTitleContentState>[0];
export type TitleContentModel = ReturnType<typeof useTitleContentModel>;
