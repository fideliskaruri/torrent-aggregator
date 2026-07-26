declare module "range-parser" {
  export type Range = {
    start: number;
    end: number;
  };

  function rangeParser(
    size: number,
    str: string,
    options?: { combine?: boolean },
  ): Range[] | -1 | -2;

  export default rangeParser;
}
