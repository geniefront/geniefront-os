import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PRICE_LIST_SYSTEM, priceListUserText } from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/prompt.ts';
import { priceListToolSchema, extractionZ } from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/schema.ts';
import { normalizeExtraction, mergeDrafts } from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/normalize.ts';
const require=createRequire('/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/package.json');
const Anthropic=require('@anthropic-ai/sdk').default;
const dir='/private/tmp/copilot-vision-benchmark-20260906';
const bytes=readFileSync('/Users/naiyouzhu/siteadmin/test_image_spa.jpg');
const base64=bytes.toString('base64');
const description='把价目表照片上的每一行录进系统。只录图上真实印着的内容，没印的字段填 0，拿不准的标 unsure。';
const sha=(x:any)=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
writeFileSync(dir+'/manifest.json',JSON.stringify({image:'/Users/naiyouzhu/siteadmin/test_image_spa.jpg',imageSha256:sha(bytes),systemPromptSha256:sha(PRICE_LIST_SYSTEM),schemaSha256:sha(priceListToolSchema),userPrompt:priceListUserText(0,1),maxOutputTokens:32000,retries:0,timeoutMs:240000,scope:'single original image, direct extraction API + existing normalization; excludes app upload/translation/database',startedAt:new Date().toISOString()},null,2));
async function run(provider:string,effort:string,index:number){
 const id=`${provider}-${effort}-${index}`; const start=performance.now(); let firstOutputMs:number|null=null; let raw:any,extraction:any,usage:any,actualModel:any;
 console.log(JSON.stringify({event:'start',id,at:new Date().toISOString()}));
 try {
  if(provider==='sonnet'){
   const client=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,timeout:240000,maxRetries:0});
   const stream=client.messages.stream({model:'claude-sonnet-5',max_tokens:32000,output_config:{effort},system:[{type:'text',text:PRICE_LIST_SYSTEM,cache_control:{type:'ephemeral'}}],tools:[{name:'record_price_list',description,strict:true,input_schema:priceListToolSchema}],tool_choice:{type:'tool',name:'record_price_list'},messages:[{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:base64}},{type:'text',text:priceListUserText(0,1)}]}]});
   stream.on('streamEvent',(e:any)=>{if(e.type==='content_block_delta'&&e.delta?.type==='input_json_delta'&&firstOutputMs===null)firstOutputMs=performance.now()-start;});
   raw=await stream.finalMessage(); usage=raw.usage; actualModel=raw.model;
   if(raw.stop_reason!=='tool_use')throw new Error('stop_reason:'+raw.stop_reason);
   extraction=raw.content.find((x:any)=>x.type==='tool_use'&&x.name==='record_price_list')?.input;
  }else{
   const endpoint=(process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'')+'/responses';
   const res=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(240000),body:JSON.stringify({model:'gpt-5.6-luna',reasoning:{effort},max_output_tokens:32000,store:false,stream:true,instructions:PRICE_LIST_SYSTEM,tools:[{type:'function',name:'record_price_list',description,strict:true,parameters:priceListToolSchema}],tool_choice:{type:'function',name:'record_price_list'},parallel_tool_calls:false,input:[{role:'user',content:[{type:'input_image',image_url:'data:image/jpeg;base64,'+base64,detail:'high'},{type:'input_text',text:priceListUserText(0,1)}]}]})});
   if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(`HTTP ${res.status}: ${e.error?.message||e.error?.code||'unknown'}`)}
   let buffer='';const decoder=new TextDecoder();
   for await(const chunk of res.body!){buffer+=decoder.decode(chunk,{stream:true});let split;while((split=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,split);buffer=buffer.slice(split+2);for(const line of block.split('\n'))if(line.startsWith('data: ')){const data=line.slice(6);if(data==='[DONE]')continue;const e=JSON.parse(data);if(e.type==='response.function_call_arguments.delta'&&firstOutputMs===null)firstOutputMs=performance.now()-start;if(e.type==='response.completed'||e.type==='response.incomplete'||e.type==='response.failed')raw=e.response;if(e.type==='error')throw new Error(e.message||e.code||'stream_error');}}}
   usage=raw?.usage;actualModel=raw?.model;if(raw?.status!=='completed')throw new Error('response_status:'+raw?.status);
   extraction=JSON.parse(raw.output.find((x:any)=>x.type==='function_call'&&x.name==='record_price_list')?.arguments||'null');
  }
  const latencyMs=performance.now()-start;const parsed=extractionZ.safeParse(extraction);
  const normalized=parsed.success?normalizeExtraction(parsed.data,{sourceSeq:0,locale:'en',widthPx:1080,heightPx:1920}):[];
  const merged=mergeDrafts([normalized]);
  const out={id,provider,effort,index,requestedModel:provider==='sonnet'?'claude-sonnet-5':'gpt-5.6-luna',actualModel,latencyMs,firstOutputMs,usage,schemaValid:parsed.success,schemaIssues:parsed.success?[]:parsed.error.issues,extraction,normalized,merged,raw};
  writeFileSync(`${dir}/${id}.json`,JSON.stringify(out,null,2));
  console.log(JSON.stringify({event:'done',id,latencyMs,firstOutputMs,schemaValid:parsed.success,rows:extraction?.items?.length,mergedRows:merged.items.length,usage}));return out;
 }catch(e:any){const out={id,provider,effort,index,error:String(e.message).slice(0,1200),latencyMs:performance.now()-start,firstOutputMs,usage,raw};writeFileSync(`${dir}/${id}.json`,JSON.stringify(out,null,2));console.log(JSON.stringify({event:'error',...out,raw:undefined}));return out;}
}
const count=Number(process.argv[2]||3);const lunaEffort=process.argv[3]||'medium';const only=process.argv[4];
await Promise.all((only?[only]:['sonnet','luna']).map(async provider=>{for(let i=1;i<=count;i++){const out=await run(provider,provider==='sonnet'?'high':lunaEffort,i);if(out.error)break;}}));
