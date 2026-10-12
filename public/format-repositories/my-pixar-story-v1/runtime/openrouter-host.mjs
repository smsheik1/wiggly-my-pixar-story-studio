import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,extname,basename} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {Event,digest} from './contracts.mjs';
import {buildWorkerPacket,wigglyToolDefinition,crewRoles,taskAssets} from './crew.mjs';
import {loadStudio} from './instructions.mjs';
import {sanitize,promptSectionsFor,labelFor,reasonCode} from './tracing.mjs';
import {AudioEditPlan} from './audio-edit.mjs';

export const OPENROUTER_URL='https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL='deepseek/deepseek-v4.1-flash';
export const OPENROUTER_PROVIDER_POLICY={require_parameters:true,max_price:{prompt:0.3,completion:1.2}};
export const OPENROUTER_MAX_TOKENS=16000;
export const OPENROUTER_MAX_TOOL_ROUNDS=40;
export const OPENROUTER_MAX_CONTINUATIONS=2;
const CONTINUE_PROMPT='Your previous reply was cut off by the output limit. Continue EXACTLY where it stopped. Output only the remaining characters, no repetition, no preamble.';
const CONTINUE_EMPTY_PROMPT='Your previous reply was empty because the output limit was reached before any output was produced. Answer now, concisely, with only the requested output.';
// Truncation: finish_reason 'length' or a native max-tokens reason (case-insensitive).
// A missing/empty content with finish 'length' counts the same way (reasoning ate the budget).
function isTruncatedChoice(choice){
 if(!choice)return false;
 const fr=choice.finish_reason;
 if(typeof fr==='string'&&fr.toLowerCase()==='length')return true;
 const nfr=choice.native_finish_reason;
 if(typeof nfr==='string'&&['length','max_tokens'].includes(nfr.toLowerCase()))return true;
 return false;
}

// productionEffort / maxTokens are per-model production overrides. The host-wide
// reasoningEffort constructor argument stays medium/high (never max/xhigh); only a
// model listed here may run higher in production. Muse Spark runs at xhigh because
// that is the setting that passed the r4 adult-sheet head-to-head (PR #31), and its
// output cap is 32K because one xhigh Muse request used ~9.7K of the old 16K cap.
export const MUSE_MAX_TOKENS=32000;
export const OPENROUTER_MODEL_TRAITS={
 'deepseek/deepseek-v4.1-flash': { reasoning:'optional', inputs:['text','image'] },
 'meta/muse-spark-1.3-contributor': { reasoning:'always-on', inputs:['text','image','video'], productionEffort:'xhigh', maxTokens:MUSE_MAX_TOKENS },
 // Ava (audio-reviewer): Gemini takes audio input; it runs at the host-wide
 // medium effort with the default 16K cap, never Muse's xhigh/32K overrides.
 'google/gemini-3.8-flash': { reasoning:'optional', inputs:['text','image','video','file','audio'], maxPrice:{prompt:1,completion:5} },
};
// Offline audio-capability allowlist: Ava's configured model must be listed here.
// listenAudio bytes go to the mediaReview Gemini provider (gemini-review.mjs);
// Ava's own model only reads its report, but the binding must still hear audio.
export const AUDIO_CAPABLE_OPENROUTER_MODELS=['google/gemini-3.8-flash'];

export function modelTraits(model){
 return OPENROUTER_MODEL_TRAITS[model] ?? { reasoning:'optional', inputs:['text'] };
}

// Per-model price ceiling (USD per million tokens). A model whose traits carry
// maxPrice gets that finite ceiling (Gemini costs $0.75/$3.75, above the
// default); every other model keeps the default. A ceiling is never removed:
// a missing, non-finite or non-positive value throws instead of going unlimited.
export function providerPolicyFor(model){
 const custom=modelTraits(model).maxPrice;
 if(custom==null)return OPENROUTER_PROVIDER_POLICY;
 for(const k of ['prompt','completion'])if(!Number.isFinite(custom[k])||custom[k]<=0)throw new Error(`OPENROUTER_MAX_PRICE_INVALID: ${model} needs a finite positive maxPrice.${k}.`);
 return {...OPENROUTER_PROVIDER_POLICY,max_price:{prompt:custom.prompt,completion:custom.completion}};
}

// Safety net: never send data: base64 bytes as tool text.
const viewKey=(sha256,region)=>`${sha256}:${region?JSON.stringify([region.x,region.y,region.width,region.height]):'full'}`;
const sanitizeDataUrls=(text)=>String(text).replace(/data:([^;,\s]+)[^,]*?;base64,[A-Za-z0-9+/=]+/g,'[binary data omitted: $1]');
const shaHex=(s)=>createHash('sha256').update(s,'utf8').digest('hex');
function traceImageSha(url){
  try{
    const m=String(url).match(/^data:[^,]*;base64,(.*)$/s);
    if(m){const bytes=Buffer.from(m[1].slice(0,8000),'base64');return shaHex(bytes);}
    return shaHex(String(url));
  }catch{return 'unknown';}
}
function messagesForTrace(messages){
  try{
    return (messages??[]).map(m=>{
      const c=m?.content;
      if(typeof c==='string')return {role:m.role,content:c};
      if(Array.isArray(c))return {role:m.role,content:c.map(p=>{
        if(p?.type==='image_url'&&typeof p?.image_url?.url==='string'){
          const sha=traceImageSha(p.image_url.url);
          return {type:'image_url',image_url:{url:`{image: ${sha}}`}};
        }
        return p;
      })};
      return {role:m?.role,content:typeof c==='string'?c:null};
    });
  }catch{return [];}
}

async function readJson(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function saveJson(path,value){await writeFile(path+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
export async function readOpenRouterKey(secretsPath){
 if(!secretsPath)throw new Error('OPENROUTER_API_KEY missing: pass --secrets with OPENROUTER_API_KEY set.');
 let source;try{source=await readFile(secretsPath,'utf8');}catch{throw new Error('OPENROUTER_API_KEY missing: pass --secrets with OPENROUTER_API_KEY set.');}
 const match=source.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.+)\s*$/m);
 if(!match)throw new Error('OPENROUTER_API_KEY missing: pass --secrets with OPENROUTER_API_KEY set.');
 const value=match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
 if(!value)throw new Error('OPENROUTER_API_KEY missing: pass --secrets with OPENROUTER_API_KEY set.');
 return value;
}
// Same argument contract as CodexHost's wiggly_tool; referenceSha256 may be omitted.
const ToolArguments=z.object({name:z.string(),sha256:z.string(),referenceSha256:z.string().nullable().optional(),edit:AudioEditPlan.nullable().optional(),region:z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).strict().nullable().optional()}).strict();
const developerInstructions=(worker)=>`You are ${worker.name}, the ${worker.role} for the Wiggly memoir format. Complete only your assigned task. Use wiggly_tool for granted assets. Return only the requested structured event; never approve for the user, submit provider calls, or claim unavailable perception.`;

export class OpenRouterHost {
 constructor({cwd, secretsPath, model=DEFAULT_OPENROUTER_MODEL, timeoutMs=180000, reasoningEffort='medium', maxTokens=null, maxToolRounds=OPENROUTER_MAX_TOOL_ROUNDS, fetcher=fetch, perceptionTools={}, perceptionProfile=null, tracer=null, profileOverride=null}={}){
  if(['max','xhigh'].includes(reasoningEffort))throw new Error('OPENROUTER_REASONING_LIMIT: reasoning effort must be medium or high, never max/xhigh.');
  if(!['low','medium','high'].includes(reasoningEffort))throw new Error('OPENROUTER_REASONING_LIMIT: reasoning effort must be medium or high.');
  this.cwd=cwd??join(process.cwd(),'host-workspace');this.secretsPath=secretsPath;this.model=model;this.timeoutMs=timeoutMs;
  this.reasoningEffort=reasoningEffort;this.maxTokens=maxTokens??OPENROUTER_MAX_TOKENS;this.maxTokensExplicit=maxTokens!=null;this.effortOverride=null;this.maxToolRounds=maxToolRounds;
  this.fetcher=fetcher;this.perceptionProfile=perceptionProfile;this.tracer=tracer;
  this.profileOverride=profileOverride;
  this.verifiedModels=new Set();
  this.tools={...perceptionTools,viewImage:async({file})=>({perception:'direct-image',imageUrl:`data:image/${extname(file.path).slice(1).replace('jpg','jpeg')};base64,${(await readFile(file.path)).toString('base64')}`})};
 }
 // Effort for one model: an evaluation override, else the model's production
 // override, else the host-wide medium/high setting.
 effortFor(model){
  return this.effortOverride??modelTraits(model).productionEffort??this.reasoningEffort;
 }
 maxTokensFor(model){
  return this.maxTokensExplicit?this.maxTokens:(modelTraits(model).maxTokens??this.maxTokens);
 }
 requestSettings(model=this.model){
  return {model,provider:providerPolicyFor(model),reasoning:{effort:this.effortFor(model)},max_tokens:this.maxTokensFor(model)};
 }
 async profile(){
  if(typeof this.profileOverride==='string')return this.profileOverride;
  const tool=wigglyToolDefinition();
  const traits=modelTraits(this.model);
  return digest({model:this.model,traits,provider:providerPolicyFor(this.model),reasoning:{effort:this.reasoningEffort},maxTokens:this.maxTokens,modelOverrides:OPENROUTER_MODEL_TRAITS,maxToolRounds:this.maxToolRounds,tool:tool.inputSchema,perception:this.perceptionProfile,instruction:'openrouter-crew-v1'});
 }
 async preflight(worker){
  if(worker.capabilityVersion!==await this.profile())throw new Error('OPENROUTER_PROFILE_CHANGED: host/tool version differs from the bound crew. Stop for explicit reconfiguration/qualification.');
  await readOpenRouterKey(this.secretsPath);
 }
 toolDefinition(){
  const tool=wigglyToolDefinition();
  return [{type:'function',function:{name:tool.name,description:tool.description,parameters:tool.inputSchema}}];
 }
  async chat({model,messages,tools,toolChoice,usageSink,reasoning,maxTokens,verify=false}){
   const key=await readOpenRouterKey(this.secretsPath);
   const traits=modelTraits(model);
   const forcingSpecificTool=toolChoice&&typeof toolChoice==='object';
   let resolvedReasoning=reasoning;
   if(traits.reasoning==='always-on'){
    if(resolvedReasoning&&typeof resolvedReasoning==='object'&&resolvedReasoning.enabled===false){
     resolvedReasoning={effort:this.effortFor(model)};
    }else if(!resolvedReasoning){
     resolvedReasoning={effort:this.effortFor(model)};
    }
   }else{
    if(!resolvedReasoning){
     resolvedReasoning=forcingSpecificTool?{enabled:false}:{effort:this.effortFor(model)};
    }
   }
   const effectiveMaxTokens=maxTokens??this.maxTokensFor(model);
   const effMaxTokens=maxTokens??this.maxTokensFor(model);
   // continuation=true: a strict json_schema response_format would force the model to start a
   // brand-new JSON object, so the remaining characters could never be stitched onto the partial.
   // Continuation requests therefore drop response_format; the first request is unchanged.
   let llmAttempt=0;
   const sendOnce=async(msgs,continuation=false)=>{
    const attempt=llmAttempt++;
    const body={model,messages:msgs,...(tools?.length?{tools,tool_choice:toolChoice??'auto'}:{}),provider:providerPolicyFor(model),max_tokens:maxTokens??this.maxTokensFor(model)};
    if(!verify&&!continuation){
     body.response_format={type:'json_schema',json_schema:{name:'event',strict:true,schema:{type:'object',properties:{eventJson:{type:'string'}},required:['eventJson'],additionalProperties:false}}};
    }
    body.reasoning=resolvedReasoning;
    let llmHandle=null;
    try{
      const traced=messagesForTrace(msgs);
      llmHandle=this.tracer?.llm?.({model,inputs:{model,messages:traced,max_tokens:effMaxTokens,reasoning:resolvedReasoning,continuation,attempt},metadata:{ls_provider:'openrouter',ls_model_name:model}});
    }catch{llmHandle=null;}
    const llmStart=Date.now();
    const endLlmOk=(result,choice)=>{
      try{
        const u=result?.usage??{};
        const usageMeta={input_tokens:Number(u.prompt_tokens)||0,output_tokens:Number(u.completion_tokens)||0,total_tokens:(Number(u.prompt_tokens)||0)+(Number(u.completion_tokens)||0),...(u.prompt_tokens_details?{input_token_details:{cached_tokens:Number(u.prompt_tokens_details.cached_tokens)||0}}:{}),output_token_details:{reasoning:Number(u.completion_tokens_details?.reasoning_tokens)||0}};
        // LangSmith reads token counts from outputs.usage_metadata (top level).
        // Billed amount from OpenRouter usage.cost. If absent, record no cost (never a guessed 0).
        const billed=u.cost!=null&&Number.isFinite(Number(u.cost));
        const costUsd=billed?Number(u.cost):0;
        llmHandle?.end?.({content:choice?.message?.content??null,tool_calls:choice?.message?.tool_calls??null,finish_reason:choice?.finish_reason??null,native_finish_reason:choice?.native_finish_reason??null,usage_metadata:billed?{...usageMeta,total_cost:costUsd}:usageMeta,...(billed?{cost_source:'billed'}:{cost_unknown:true,cost_note:`cost unknown for openrouter/${model}`}),inputTokens:usageMeta.input_tokens,outputTokens:usageMeta.output_tokens,reasoningTokens:usageMeta.output_token_details.reasoning,costUsd,generationId:result?.id??null,provider:result?.provider??null,durationMs:Date.now()-llmStart,model});
      }catch{}
    };
    const endLlmFail=(err,status,text)=>{
      try{llmHandle?.end?.({error:String(err?.message??err??'').slice(0,800),status:status??null,bodySnippet:String(text??'').slice(0,800),reasonCode:reasonCode(err),durationMs:Date.now()-llmStart,model},String(err?.message??err??'').slice(0,300));}catch{}
    };
    let response;
    try{
     response=await this.fetcher(OPENROUTER_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'Wiggly memoir studio'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
    }catch(error){const e=new Error(`OPENROUTER_REQUEST_FAILED: ${error.message}. No model/provider fallback was submitted.`);endLlmFail(e,null,null);throw e;}
    if(!response.ok){
     const text=await response.text().catch(()=> '');
     // Bind-time verification only: a task turn's 400/401 keeps the generic error below.
     if(verify&&(response.status===401||response.status===403)){const e=new Error(`OPENROUTER_AUTH_FAILED: OpenRouter rejected the API key (HTTP ${response.status}). No worker was bound.`);endLlmFail(e,response.status,text);throw e;}
     if(verify&&(response.status===400||response.status===404)){const e=new Error(`OPENROUTER_MODEL_UNAVAILABLE: ${model} was rejected by OpenRouter (HTTP ${response.status}). No worker was bound.${text?` ${text.slice(0,200).split(key).join('[REDACTED]')}`:''}`);endLlmFail(e,response.status,text);throw e;}
     if(response.status===402){const e=new Error('OpenRouter credits exhausted. Add credits before dispatch; no model/provider fallback was submitted.');endLlmFail(e,402,text);throw e;}
     if(response.status===429){
      const error=new Error(`OpenRouter usage limit reached (HTTP 429). No model/provider fallback was submitted.`);
      error.safeRetryWithoutOutput=true;error.savedTools=[];error.usageLimitExceeded=true;error.retryAfter=response.headers?.get?.('retry-after')??null;
      endLlmFail(error,429,text);
      throw error;
     }
     if(response.status>=500){const e=new Error(`OPENROUTER_REQUEST_FAILED: HTTP ${response.status}. No model/provider fallback was submitted.`);endLlmFail(e,response.status,text);throw e;}
     const e=new Error(`OPENROUTER_REQUEST_FAILED: HTTP ${response.status} ${text.slice(0,200)}. No model/provider fallback was submitted.`);endLlmFail(e,response.status,text);throw e;
    }
    const result=await response.json();
    if(result?.usage&&usageSink)usageSink(result.usage);
    if(result?.model&&result.model!==model){const e=new Error('OPENROUTER_MODEL_CHANGED: requested model must be used exactly.');endLlmFail(e,null,null);throw e;}
    const choice=result?.choices?.[0];
    if(!choice){const e=new Error('OPENROUTER_REQUEST_FAILED: empty choices. No model/provider fallback was submitted.');endLlmFail(e,null,null);throw e;}
    endLlmOk(result,choice);
    return choice;
   };
  const cur=[...(messages??[])];
  const parts=[];
  let choice=await sendOnce(cur);
  let continuations=0;
  // verify (bind ping) never continues: a truncated ping keeps the current behaviour.
  while(!verify&&isTruncatedChoice(choice)){
   const msg=choice.message??{};
   // Truncated tool_calls are never executed: partial tool arguments would be
   // invalid JSON. Drop them and continue as a text turn; the stitched content
   // below carries the full answer. If the model keeps truncating, OUTPUT_TRUNCATED.
   const partial=typeof msg.content==='string'?msg.content:(msg.content==null?'':JSON.stringify(msg.content));
   parts.push(partial);
   if(continuations>=OPENROUTER_MAX_CONTINUATIONS){
    const error=new Error(`OUTPUT_TRUNCATED: ${model} hit the ${effectiveMaxTokens}-token output limit ${continuations+1} times; answer still incomplete. Increase max_tokens or shorten the task.`);
    error.outputTruncated=true;
    throw error;
   }
   continuations++;
   cur.push({role:'assistant',content:partial});
   cur.push({role:'user',content:parts.join('')?CONTINUE_PROMPT:CONTINUE_EMPTY_PROMPT});
   choice=await sendOnce(cur,true);
  }
  if(!parts.length)return choice.message;
  const finalMsg=choice.message??{};
  const finalContent=typeof finalMsg.content==='string'?finalMsg.content:(finalMsg.content==null?'':JSON.stringify(finalMsg.content));
  return {...finalMsg,content:parts.join('')+finalContent};
 }
  async runTask(task,{worker,callTool}){
   await this.preflight(worker);
   const packet=buildWorkerPacket(task,worker);
   const system=developerInstructions(worker);
   const media=[],attached=new Set();
   if((task.allowedTools??crewRoles[worker.role].tools).includes('viewImage'))for(const file of taskAssets(task).values())if(file.width&&!file.durationSeconds){
    if(!modelTraits(worker.modelVersion).inputs.includes('image')){
     const error=new Error(`OPENROUTER_VISION_UNSUPPORTED: ${worker.modelVersion} cannot take images; bind a vision model for ${worker.role}.`);
     error.stopDispatch=true;
     throw error;
    }
    const viewed=await callTool('viewImage',{sha256:file.sha256});media.push({type:'text',text:`Reference image sha256: ${file.sha256}`},{type:'image_url',image_url:{url:viewed.imageUrl}});attached.add(viewKey(file.sha256));
   }
  const tools=this.toolDefinition();
  const content=[{type:'text',text:packet},...media];
  const messages=[{role:'system',content:system},{role:'user',content}];
  const label=labelFor(worker);
  let promptSections=[];
  try{promptSections=promptSectionsFor(task);}catch{promptSections=[];}
  const packetSha256=shaHex(packet);
  const attachedShas=[...attached].map(k=>String(k).split(':')[0]);
  const studioSha256=task.studioSha256??task.studioConfig?.sha256??null;
  // Nesting: if the caller (driveCrew/executeCase) already opened a crew-turn via
  // tracer.within(), create only the agent-call under it; otherwise own the turn.
  let outerTurn=null, ownsTurn=false, parentTurn=null;
  try{
    const cur=this.tracer?.current?.();
    if(cur&&cur.kind==='crew-turn'){parentTurn=cur;}
    if(!(cur&&cur.kind==='crew-turn')){
      outerTurn=this.tracer?.turn?.({role:worker.role,label,workerName:worker.name,workerId:worker.workerId,model:worker.modelVersion,backend:'openrouter',taskId:task.taskId,step:task.step,gate:task.gate,attempt:task.attempt??1,studioSha256});
      ownsTurn=!!outerTurn;
    }
  }catch{outerTurn=null;ownsTurn=false;}
  let agentHandle=null;
  try{
    const startFields={role:worker.role,label,workerName:worker.name,workerId:worker.workerId,model:worker.modelVersion,backend:'openrouter',taskId:task.taskId,step:task.step,gate:task.gate,studioSha256,system,packet,promptSections,packetSha256,packetChars:packet.length,attached:attachedShas};
    if(outerTurn&&this.tracer?.within){
      // Create the agent-call inside the owned turn so llm/tool nest under it.
      agentHandle=this.tracer.within(outerTurn,()=>this.tracer?.agentCall?.(startFields));
      if(!agentHandle)agentHandle=null;
    }else{
      agentHandle=this.tracer?.agentCall?.(startFields);
    }
    if(['visual-reviewer','scene-reviewer'].includes(worker.role)){
      const files=task.artifact?.content?.files??(task.artifact?.content?.file?[task.artifact.content.file]:[]);
      if(Array.isArray(files)){
        const targetRun=parentTurn??outerTurn??agentHandle;
        if(targetRun){
          for(const [idx,f] of files.entries()){
            const name=files.length===1?(f.path?basename(f.path):'image.png'):`option-${idx}-${f.path?basename(f.path):'image.png'}`;
            this.tracer?.attachImage?.(targetRun,{name,path:f.path,sha256:f.sha256});
          }
        }
      }
    }
  }catch{agentHandle=null;}
  const runWithinAgent=(fn)=>(agentHandle&&this.tracer?.within)?this.tracer.within(agentHandle,fn):fn();
  const turnStart=Date.now(),usage={requests:0,promptCount:0,completionCount:0,costUsd:0};
  const totals={requests:0,inputTokens:0,outputTokens:0,reasoningTokens:0,cachedTokens:0,costUsd:0};
  let turnEnded=false,validationRetries=0,agentEnded=false;
  const addUsage=u=>{
    usage.requests++;usage.promptCount+=Number(u?.prompt_tokens)||0;usage.completionCount+=Number(u?.completion_tokens)||0;usage.costUsd+=Number(u?.cost)||0;
    totals.requests++;totals.inputTokens+=Number(u?.prompt_tokens)||0;totals.outputTokens+=Number(u?.completion_tokens)||0;
    totals.reasoningTokens+=Number(u?.completion_tokens_details?.reasoning_tokens)||0;
    totals.cachedTokens+=Number(u?.prompt_tokens_details?.cached_tokens)||0;
    totals.costUsd+=Number(u?.cost)||0;
  };
  const endAgent=(fields={},errText)=>{
    if(agentEnded)return;agentEnded=true;
    try{agentHandle?.end?.(fields,errText);}catch{}
  };
  const endTurn=(outcome,extra={})=>{
    if(turnEnded)return;turnEnded=true;
    try{
      const rc=extra.error?reasonCode(extra.error):null;
      outerTurn?.end?.({outcome,durationMs:Date.now()-turnStart,validationRetries,usage:sanitize(usage),...totals,...extra,...(rc?{reasonCode:rc}:{})});
    }catch{}
  };
  // When we own the turn, run the whole task inside it so llm/tool nest correctly.
  const taskBody=async()=>{
  let output=null,attempts=0,parsedEvent=null;
  try{
   const loopBody=async()=>{
   for(let round=0;round<this.maxToolRounds;round++){
    const message=await this.chat({model:worker.modelVersion,messages,tools,usageSink:addUsage});
    const calls=message?.tool_calls??[];
    if(!calls.length){output=typeof message?.content==='string'?message.content:JSON.stringify(message?.content??'');break;}
     messages.push({role:'assistant',content:message.content??'',tool_calls:calls});
     const pending=[];
     for(const call of calls){
      let args=null;try{args=JSON.parse(call.function?.arguments||'{}');}catch{args=null;}
      const checked=call.function?.name==='wiggly_tool'?ToolArguments.safeParse(args):{success:false,error:{message:`unknown tool ${call.function?.name}`}};
      if(!checked.success){
        let invTrace=null;try{invTrace=this.tracer?.tool?.({toolName:args?.name??call.function?.name??'unknown',args:args??{raw:call.function?.arguments??''}});}catch{invTrace=null;}
        const t0=Date.now();
        try{invTrace?.end?.({outcome:'invalid-args',durationMs:Date.now()-t0,error:String(checked.error.message).slice(0,500)});}catch{}
        messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(`TOOL_ARGUMENTS_INVALID: ${checked.error.message}`)});continue;
      }
      const parsed=checked.data;
      const toolArgs={sha256:parsed.sha256,...(parsed.referenceSha256?{referenceSha256:parsed.referenceSha256}:{}),...(parsed.edit?{edit:parsed.edit}:{}),...(parsed.region?{region:parsed.region}:{})};
      let toolTrace=null;try{toolTrace=this.tracer?.tool?.({toolName:parsed.name,name:parsed.name,args:toolArgs});}catch{toolTrace=null;}
      const toolStart=Date.now();
      const endTool=(outcome,extra={})=>{try{toolTrace?.end?.({outcome,durationMs:Date.now()-toolStart,args:toolArgs,...extra});}catch{}};
      try{
       const value=await callTool(parsed.name,{sha256:parsed.sha256,...(parsed.referenceSha256?{referenceSha256:parsed.referenceSha256}:{}),...(parsed.edit?{edit:parsed.edit}:{}),...(parsed.region?{region:parsed.region}:{})});
       if(value&&typeof value==='object'&&typeof value.imageUrl==='string'){
        if(!modelTraits(worker.modelVersion).inputs.includes('image')){
         const error=new Error(`OPENROUTER_VISION_UNSUPPORTED: ${worker.modelVersion} cannot take images; bind a vision model for ${worker.role}.`);
         error.stopDispatch=true;
         throw error;
        }
        // A region close-up is a different image of the same hash: key on sha256 + region.
        const key=viewKey(parsed.sha256,parsed.region),already=attached.has(key);
        const compact=already
         ?{perception:value.perception??'direct-image',sha256:parsed.sha256,alreadyAttached:true,note:`image sha256 ${parsed.sha256} already attached above; use the attached image`}
         :{perception:value.perception??'direct-image',sha256:parsed.sha256,attached:true,note:`image attached as image_url below for sha256 ${parsed.sha256}`};
        endTool('completed',{output:{sha256:parsed.sha256,attached:!already}});
        messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(JSON.stringify(compact))});
        if(!already){attached.add(key);pending.push({sha256:parsed.sha256,region:parsed.region??null,url:value.imageUrl});}
        continue;
       }
       const summary=value?.bytes
         ?{file:value.file,...(/\.(json|md|txt)$/i.test(value.file.path)?{text:value.bytes.toString('utf8').slice(0,8000)}:{instruction:'Binary media: use your permitted perception tool.'})}
         :value;
       endTool('completed',{output:summary});
       messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(JSON.stringify(value.bytes?{file:value.file,...(/\.(json|md|txt)$/i.test(value.file.path)?{text:value.bytes.toString('utf8')}:{instruction:'Binary media: use your permitted perception tool.'})}:value))});
      }catch(error){endTool('failed',{error:String(error?.message??error??'').slice(0,500)});messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(error.message)});if(error.stopDispatch)throw error;}
     }
     if(pending.length){
      const parts=[];
      for(const p of pending)parts.push({type:'text',text:`viewImage result for sha256 ${p.sha256}${p.region?` region ${JSON.stringify(p.region)}`:''}`},{type:'image_url',image_url:{url:p.url}});
      messages.push({role:'user',content:parts});
     }
   }
   if(output==null)throw new Error(`OPENROUTER_TOOL_LIMIT: exceeded ${this.maxToolRounds} tool rounds without a final answer.`);
   try{const ev=Event.parse(JSON.parse(JSON.parse(output).eventJson));parsedEvent=ev;return ev;}
   catch(error){
    attempts++;validationRetries=attempts;
    if(attempts>1){const e=Object.assign(new Error(`INVALID_WORKER_EVENT: ${error.message}`),{knownFinished:true,finishedResult:output});e.validationRetries=validationRetries;throw e;}
    messages.push({role:'assistant',content:output});
    messages.push({role:'user',content:`Your last reply failed validation: ${error.message}. Return ONLY {"eventJson": "<serialized Event>"} with the corrected event.`});
    const retry=await this.chat({model:worker.modelVersion,messages,tools,toolChoice:'none',usageSink:addUsage});
    const retryText=typeof retry?.content==='string'?retry.content:JSON.stringify(retry?.content??'');
    try{const event=Event.parse(JSON.parse(JSON.parse(retryText).eventJson));output=retryText;parsedEvent=event;return event;}
    catch(error2){const e=Object.assign(new Error(`INVALID_WORKER_EVENT: ${error2.message}`),{knownFinished:true,finishedResult:retryText});e.validationRetries=validationRetries;throw e;}
   }
   };
   // Ensure llm/tool records nest under the agent-call.
   const event=await runWithinAgent(loopBody);
   endAgent({output,event:parsedEvent,validationRetries,usage:sanitize(usage),...totals,durationMs:Date.now()-turnStart});
   try{if(parentTurn)parentTurn._childTotals={...totals,validationRetries};}catch{}
   if(ownsTurn)endTurn('completed',{validationRetries,usage:sanitize(usage),...totals});
   return event;
  }catch(error){
    const rc=reasonCode(error);
    const finished=error.finishedResult??(output??null);
    endAgent({error:String(error?.message??error??'').slice(0,1000),reasonCode:rc,validationRetries,usage:sanitize(usage),...totals,durationMs:Date.now()-turnStart,...(finished?{finishedResult:finished}:{})},String(error?.message??'').slice(0,300));
    try{if(parentTurn)parentTurn._childTotals={...totals,validationRetries,error:String(error?.message??'').slice(0,500),reasonCode:rc};}catch{}
    if(ownsTurn)endTurn('error',{error:String(error?.message??error??'').slice(0,1000),reasonCode:rc,validationRetries,usage:sanitize(usage),...totals});
    throw error;
  }
  };
  // If we own the turn, the agent-call already nests via within(outerTurn) above,
  // but llm/tool need the agent context: run taskBody inside agent when possible.
  if(agentHandle&&this.tracer?.within){
    // Never re-run the task on error: a tracer problem must not double a paid call.
    return await this.tracer.within(agentHandle,taskBody);
  }
  return await taskBody();
 }
 // Cheap stateless connectivity/auth/model check, at most once per distinct
 // model per host instance. Only success binds; content is never inspected.
 async verifyModel(model){
  if(this.verifiedModels.has(model))return;
  const traits=modelTraits(model);
  const reasoning=traits.reasoning==='always-on'?{effort:'low'}:{enabled:false};
  const maxTokens=traits.reasoning==='always-on'?512:16;
  await this.chat({model,messages:[{role:'user',content:'ping'}],reasoning,maxTokens,verify:true});
  this.verifiedModels.add(model);
 }
 async startCrew(model,config=loadStudio().config){
  const capabilityVersion=await this.profile(),path=join(this.cwd,'crew-startup-openrouter.json');
  const openRoles=Object.entries(config.agents).filter(([,a])=>(a.backend??'codex')==='openrouter');
  const models=Object.fromEntries(openRoles.map(([role,a])=>[role,model??a.model]));
  for(const [role,agent] of openRoles){
   const m=models[role];
   const tools=agent.tools??crewRoles[role]?.tools??[];
   if(tools.some(t=>['viewImage','watchVideo'].includes(t))&&!modelTraits(m).inputs.includes('image')){
    const error=new Error(`OPENROUTER_VISION_UNSUPPORTED: ${m} cannot take images; bind a vision model for ${role}.`);
    error.stopDispatch=true;
    throw error;
   }
  }
  // Resumable cache only: keep saved workers still matching role, model and
  // capability; drop the rest and ignore any stale pending marker.
  const saved=await readJson(path);
  const keptByRole=new Map((saved?.workers??[]).filter(w=>models[w.role]!==undefined&&w.modelVersion===models[w.role]&&w.capabilityVersion===capabilityVersion).map(w=>[w.role,w]));
  for(const m of new Set(openRoles.filter(([role])=>!keptByRole.has(role)).map(([role])=>models[role])))await this.verifyModel(m);
  const workers=openRoles.map(([role,agent])=>keptByRole.get(role)??{workerId:`openrouter:${role}:${randomUUID().slice(0,8)}`,name:agent.name,role,modelVersion:models[role],capabilityVersion,execution:'host',backend:'openrouter'});
  await saveJson(path,{models,capabilityVersion,workers,pending:null});
  return {workers};
 }
 async refreshCrew(crew){
  const capabilityVersion=await this.profile();
  return {workers:crew.workers.map(w=>({...w,capabilityVersion}))};
 }
 // Single-role bind without touching the startup file (crew-refresh rebind).
 async startRole(role,agent){
  const m=agent.model;
  const tools=agent.tools??crewRoles[role]?.tools??[];
  if(tools.some(t=>['viewImage','watchVideo'].includes(t))&&!modelTraits(m).inputs.includes('image')){
   const error=new Error(`OPENROUTER_VISION_UNSUPPORTED: ${m} cannot take images; bind a vision model for ${role}.`);
   error.stopDispatch=true;
   throw error;
  }
  const capabilityVersion=await this.profile();
  await this.verifyModel(agent.model);
  const workerId=`openrouter:${role}:${randomUUID().slice(0,8)}`;
  return {workerId,name:agent.name,role,modelVersion:agent.model,capabilityVersion,execution:'host',backend:'openrouter'};
 }
 close(){}
}
