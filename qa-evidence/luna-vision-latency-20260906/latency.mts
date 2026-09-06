import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {PRICE_LIST_SYSTEM,priceListUserText} from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/prompt.ts';
import {priceListToolSchema,extractionZ} from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/schema.ts';
import {normalizeExtraction,mergeDrafts} from '/Users/naiyouzhu/siteadmin/geniefront-os/packages/ai/src/normalize.ts';
const dir='/private/tmp/luna-vision-latency-20260906';mkdirSync(dir,{recursive:true});
const str={type:'string'},num={type:'integer'};
const obj=(properties:any)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const arr=(items:any)=>({type:'array',items});
const compact=obj({groups:arr(obj({category:str,rows:arr(obj({
 n:{type:'string',description:'原文项目名称或说明全文'},
 k:{type:'string',enum:['service','addon','package','note','price_modifier']},
 p:{...arr(obj({l:{type:'string',description:'价格档位原文标签；单价无标签时空串'},d:{...num,description:'分钟，未印0'},c:{...num,description:'整数美分，未印0'}})),description:'单价也只存一项，多档全部保留；无价格说明行给空数组'},
 f:{type:'boolean',description:'是否起步价'},
 q:{type:'string',enum:['certain','likely','unsure']},
 b:{...arr(num),description:'原图像素框[x1,y1,x2,y2]，恰好4项'},
 pkg:{anyOf:[{type:'null'},obj({s:{...num,description:'明确印出的核销次数，未印0'},names:arr(str),days:{...num,description:'明确有效天数，未印0'}})],description:'仅套餐有此对象；其余null'},
 unit:{type:['string','null'],description:'原图计价单位限定如 each；没有则null'}
 }))})),unresolved:priceListToolSchema.properties.unresolved});
const extra='\n\n本次使用等价紧凑格式：分类只在groups.category写一次。rows内 n=名称,k=kind,p=完整价格档位(单价也一项),f=起步价,q=置信度,b=像素框,pkg=套餐信息,unit=印出的计价单位。不重复输出最低价，程序从p取最小价格。没有印核销次数就pkg.s=0。保留全部原文、所有价格档位、说明与位置，不以少录项目换取简短。';
writeFileSync(dir+'/compact-schema.json',JSON.stringify(compact,null,2));
function expand(data:any){return {items:data.groups.flatMap((g:any)=>g.rows.map((r:any)=>({name:r.n,category:g.category,kind:r.k,price_cents:r.p.length?Math.min(...r.p.map((p:any)=>p.c)):0,duration_min:r.p.length===1?r.p[0].d:0,price_is_from:r.f,variants:r.p.length>1?r.p.map((p:any)=>({label:p.l||`${p.d} mins`,duration_min:p.d,price_cents:p.c})):[],confidence:r.q,bbox:{x1:r.b[0],y1:r.b[1],x2:r.b[2],y2:r.b[3]},package_sessions:r.pkg?.s||0,package_service_names:r.pkg?.names||[],package_valid_days:r.pkg?.days||0,unit:r.unit}))),unresolved:data.unresolved};}
const image=readFileSync('/Users/naiyouzhu/siteadmin/test_image_spa.jpg').toString('base64');
async function run(mode:string,index:number){
 const id=`luna-${mode}-${index}`,effort=mode.endsWith('none')?'none':'medium';const isCompact=mode.startsWith('compact');const start=performance.now();let firstOutputMs:any=null,raw:any,args:any;
 console.log(JSON.stringify({event:'start',id}));
 try{
 const res=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(180000),body:JSON.stringify({model:'gpt-5.6-luna',reasoning:{effort},max_output_tokens:32000,store:false,stream:true,instructions:PRICE_LIST_SYSTEM+(isCompact?extra:''),tools:[{type:'function',name:'record_price_list',description:'把价目表照片上的每一行录进系统。只录图上真实印着的内容，没印的字段填 0，拿不准的标 unsure。',strict:true,parameters:isCompact?compact:priceListToolSchema}],tool_choice:{type:'function',name:'record_price_list'},parallel_tool_calls:false,input:[{role:'user',content:[{type:'input_image',image_url:'data:image/jpeg;base64,'+image,detail:'high'},{type:'input_text',text:priceListUserText(0,1)}]}]})});
 if(!res.ok){const e=await res.json();throw new Error(`${res.status}: ${e.error?.message}`)}
 let buffer='';const dec=new TextDecoder();for await(const chunk of res.body!){buffer+=dec.decode(chunk,{stream:true});let pos;while((pos=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,pos);buffer=buffer.slice(pos+2);for(const line of block.split('\n'))if(line.startsWith('data: ')&&line.slice(6)!=='[DONE]'){const e=JSON.parse(line.slice(6));if(e.type==='response.function_call_arguments.delta'&&firstOutputMs===null)firstOutputMs=performance.now()-start;if(e.type==='response.completed'||e.type==='response.incomplete'||e.type==='response.failed')raw=e.response;if(e.type==='error')throw new Error(e.message);}}}
 const latencyMs=performance.now()-start;if(raw?.status!=='completed')throw new Error('status:'+raw?.status);args=JSON.parse(raw.output.find((o:any)=>o.type==='function_call').arguments);
 const extraction=isCompact?expand(args):args;const parsed=extractionZ.safeParse(extraction);const normalized=parsed.success?normalizeExtraction(parsed.data,{sourceSeq:0,locale:'en',widthPx:1080,heightPx:1920}):[];
 const out={id,provider:'luna',effort,mode,index,actualModel:raw.model,latencyMs,firstOutputMs,usage:raw.usage,schemaValid:parsed.success,schemaIssues:parsed.success?[]:parsed.error.issues,extraction,normalized,merged:mergeDrafts([normalized]),args,raw};writeFileSync(`${dir}/${id}.json`,JSON.stringify(out,null,2));console.log(JSON.stringify({event:'done',id,latencyMs,firstOutputMs,usage:raw.usage,schemaValid:parsed.success,rows:extraction.items.length}));return true;
 }catch(e:any){writeFileSync(`${dir}/${id}.json`,JSON.stringify({id,error:e.message,raw,args},null,2));console.log(JSON.stringify({event:'error',id,error:e.message}));return false;}
}
await Promise.all((process.argv.length>2?process.argv.slice(2):['none','compact']).map(async mode=>{for(let i=1;i<=3;i++)if(!await run(mode,i))break;}));
