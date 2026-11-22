// Pure request identity contract; rendered transitions are tested separately through MCP.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const exports: Record<string, any> = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/title/title-url.ts', import.meta.url),'utf8'), {
  compilerOptions: {module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText, {exports,URL,URLSearchParams,require:()=>({encodeKeySegment:encodeURIComponent})});
const {buildDetailUrl,detailDataIdentity} = exports;
const props={workKey:'series:a',title:'Series A',mediaType:'series'};
const first=buildDetailUrl({...props,season:1});
const second=buildDetailUrl({...props,season:2,rememberedSeason:2});
assert.notEqual(first,second,'selected season still changes the actual request');
assert.equal(detailDataIdentity(first),detailDataIdentity(second),'one title stays mounted across selected/remembered seasons');
for (const change of [{workKey:'series:b'},{provider:'tmdb',providerId:'8'},{title:'Another title'},{mediaType:'movie'}]) {
  assert.notEqual(detailDataIdentity(first),detailDataIdentity(buildDetailUrl({...props,...change,season:2})), 'different title/identity hints must clear prior data');
}
console.log('PASS season request changes, same-title retention and four cross-identity isolation cases');
