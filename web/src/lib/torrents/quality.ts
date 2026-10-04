export function qualityLabel(resolution: number | null | undefined): string | null {
  if (!resolution) return null;
  return resolution >= 2160 ? "4K" : `${resolution}p`;
}
