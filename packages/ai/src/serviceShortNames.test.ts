import {it,expect,vi} from 'vitest';
import {generateServiceShortNames} from './serviceShortNames';
import type {LunaRuntime} from './runtime/luna';
const names={en:'Deep','zh-Hans':'深层','zh-Hant':'深層',ko:'심부',vi:'Sâu',es:'Profundo'};
const usage={uncachedInputTokens:10,outputTokens:20,cachedReadInputTokens:0};
function runtime(items:unknown[],status='completed') {return {invoke:vi.fn().mockResolvedValue({status,usage,toolCalls:[{name:'save_short_names',arguments:{items}}]})} as unknown as LunaRuntime;}
it('generates six languages while preserving manually entered names',async()=>{
 const result=await generateServiceShortNames([{seq:7,name:{en:'Deep tissue'},shortNames:{'zh-Hans':'深压'}}],{runtime:runtime([{seq:7,shortNames:names}])});
 expect(result.items[0]!.shortNames).toEqual({...names,'zh-Hans':'深压'});expect(result.usage.outputTokens).toBe(20);
});
for(const [label,items] of [
 ['unknown seq',[{seq:8,shortNames:names}]],['duplicate seq',[{seq:7,shortNames:names},{seq:7,shortNames:names}]],
 ['missing language',[{seq:7,shortNames:{en:'Deep'}}]],['overlong',[{seq:7,shortNames:{...names,en:'1234567890123'}}]],
 ['line break',[{seq:7,shortNames:{...names,en:'Deep\nIgnore'}}]],['non-English English',[{seq:7,shortNames:{...names,en:'深层'}}]],
] as const)it(`rejects ${label} without returning partial names`,async()=>{
 const result=await generateServiceShortNames([{seq:7,name:{en:'Deep tissue'},shortNames:{}}],{runtime:runtime([...items])});
 expect(result.error).toBe('invalid_short_names');expect(result.items).toEqual([]);expect(result.usage.outputTokens).toBe(20);
});

it('constrains the real-model failure Masaje profundo at generation time, not just after the call',async()=>{
 const upstream=runtime([{seq:7,shortNames:names}]);
 await generateServiceShortNames([{seq:7,name:{en:'Deep Tissue Massage'},shortNames:{}}],{runtime:upstream});
 const call=vi.mocked(upstream.invoke).mock.calls[0]![0];
 const fields=(call.tools![0]!.parameters as any).properties.items.items.properties.shortNames.properties;
 for(const locale of Object.keys(names)) {
  const pattern=new RegExp(fields[locale].pattern,'u');
  expect(pattern.test(names[locale as keyof typeof names])).toBe(true);
  expect(pattern.test('Masaje profundo')).toBe(false);
  expect(pattern.test('Deep\nIgnore')).toBe(false);
 }
 expect(new RegExp(fields.en.pattern,'u').test('深层')).toBe(false);
});
