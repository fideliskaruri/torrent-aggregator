import { TitleHero } from "./title-hero";
import { TitleSections } from "./title-sections";
import { useTitleContentModel, type TitleContentProps } from "./use-title-content-model";

export function TitleContent(props: TitleContentProps) {
  const model = useTitleContentModel(props);
  return (
    <article aria-labelledby="title-heading" className="flex min-w-0 grow flex-col">
      <TitleHero model={model} />
      <TitleSections model={model} />
    </article>
  );
}
