import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {Event,digest} from './contracts.mjs';
import {buildWorkerPacket,wigglyToolDefinition,crewRoles,taskAssets} from './crew.mjs';
import {loadStudio} from './instructions.mjs';
import {sanitize} from './tracing.mjs';
import {AudioEditPlan} from './audio-edit.mjs';

export const OPENROUTER_URL='https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_OPENROUTER_MODEL='deepseek/deepseek-v4.1-flash';
export const OPENROUTER_PROVIDER_POLICY={require_parameters:true,max_price:{prompt:0.3,completion:1.2}};
export const OPENROUTER_MAX_TOKENS=16000;
export const OPENROUTER_MAX_TOOL_ROUNDS=40;

// productionEffort / maxTokens are per-model production overrides. The host-wide
// reasoningEffort constructor argument stays medium/high (never max/xhigh); only a
// model listed here may run higher in production. Muse Spark runs at xhigh because
// that is the setting that passed the r4 adult-sheet head-to-head (PR #31), and its
// output cap is 32K because one xhigh Muse request used ~9.7K of the old 16K cap.
export const MUSE_MAX_TOKENS=32000;
export const OPENROUTER_MODEL_TRAITS={
 'deepseek/deepseek-v4.1-flash': { reasoning:'optional', inputs:['text','image'] },
 'meta/muse-spark-1.3-contributor': { reasoning:'always-on', inputs:['text','image','video'], productionEffort:'xhigh', maxTokens:MUSE_MAX_TOKENS },
};

export function modelTraits(model){
 return OPENROUTER_MODEL_TRAITS[model] ?? { reasoning:'optional', inputs:['text'] };
}

// Safety net: never send data: base64 bytes as tool text.
const viewKey=(sha256,region)=>`${sha256}:${region?JSON.stringify([region.x,region.y,region.width,region.height]):'full'}`;
const sanitizeDataUrls=(text)=>String(text).replace(/data:([^;,\s]+)[^,]*?;base64,[A-Za-z0-9+/=]+/g,'[binary data omitted: $1]');

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
  return {model,provider:OPENROUTER_PROVIDER_POLICY,reasoning:{effort:this.effortFor(model)},max_tokens:this.maxTokensFor(model)};
 }
 async profile(){
  if(typeof this.profileOverride==='string')return this.profileOverride;
  const tool=wigglyToolDefinition();
  const traits=modelTraits(this.model);
  return digest({model:this.model,traits,provider:OPENROUTER_PROVIDER_POLICY,reasoning:{effort:this.reasoningEffort},maxTokens:this.maxTokens,modelOverrides:OPENROUTER_MODEL_TRAITS,maxToolRounds:this.maxToolRounds,tool:tool.inputSchema,perception:this.perceptionProfile,instruction:'openrouter-crew-v1'});
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
  const body={model,messages,...(tools?.length?{tools,tool_choice:toolChoice??'auto'}:{}),provider:OPENROUTER_PROVIDER_POLICY,max_tokens:maxTokens??this.maxTokensFor(model)};
  if(!verify){
   body.response_format={type:'json_schema',json_schema:{name:'event',strict:true,schema:{type:'object',properties:{eventJson:{type:'string'}},required:['eventJson'],additionalProperties:false}}};
  }
  body.reasoning=resolvedReasoning;
  let response;
  try{
   response=await this.fetcher(OPENROUTER_URL,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json','X-Title':'Wiggly memoir studio'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(this.timeoutMs)});
  }catch(error){throw new Error(`OPENROUTER_REQUEST_FAILED: ${error.message}. No model/provider fallback was submitted.`);}
  if(!response.ok){
   const text=await response.text().catch(()=>'');
   // Bind-time verification only: a task turn's 400/401 keeps the generic error below.
   if(verify&&(response.status===401||response.status===403))throw new Error(`OPENROUTER_AUTH_FAILED: OpenRouter rejected the API key (HTTP ${response.status}). No worker was bound.`);
   if(verify&&(response.status===400||response.status===404))throw new Error(`OPENROUTER_MODEL_UNAVAILABLE: ${model} was rejected by OpenRouter (HTTP ${response.status}). No worker was bound.${text?` ${text.slice(0,200).split(key).join('[REDACTED]')}`:''}`);
   if(response.status===402)throw new Error('OpenRouter credits exhausted. Add credits before dispatch; no model/provider fallback was submitted.');
   if(response.status===429){
    const error=new Error(`OpenRouter usage limit reached (HTTP 429). No model/provider fallback was submitted.`);
    error.safeRetryWithoutOutput=true;error.savedTools=[];error.usageLimitExceeded=true;error.retryAfter=response.headers?.get?.('retry-after')??null;
    throw error;
   }
   if(response.status>=500)throw new Error(`OPENROUTER_REQUEST_FAILED: HTTP ${response.status}. No model/provider fallback was submitted.`);
   throw new Error(`OPENROUTER_REQUEST_FAILED: HTTP ${response.status} ${text.slice(0,200)}. No model/provider fallback was submitted.`);
  }
  const result=await response.json();
  if(result?.usage&&usageSink)usageSink(result.usage);
  if(result?.model&&result.model!==model)throw new Error('OPENROUTER_MODEL_CHANGED: requested model must be used exactly.');
  const choice=result?.choices?.[0];
  if(!choice)throw new Error('OPENROUTER_REQUEST_FAILED: empty choices. No model/provider fallback was submitted.');
  return choice.message;
 }
  async runTask(task,{worker,callTool}){
   await this.preflight(worker);
   const packet=buildWorkerPacket(task,worker);
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
  const messages=[{role:'system',content:developerInstructions(worker)},{role:'user',content}];
  let turnTrace=null;try{turnTrace=this.tracer?.turn?.({role:worker.role,workerName:worker.name,model:worker.modelVersion,taskId:task.taskId,step:task.step,gate:task.gate,backend:'openrouter'});}catch{turnTrace=null;}
  const turnStart=Date.now(),usage={requests:0,promptCount:0,completionCount:0,costUsd:0};let turnEnded=false,validationRetries=0;
  const addUsage=u=>{usage.requests++;usage.promptCount+=Number(u?.prompt_tokens)||0;usage.completionCount+=Number(u?.completion_tokens)||0;usage.costUsd+=Number(u?.cost)||0;};
  const endTurn=(outcome)=>{if(turnEnded)return;turnEnded=true;try{turnTrace?.end?.({outcome,durationMs:Date.now()-turnStart,validationRetries,usage:sanitize(usage)});}catch{}};
  let output=null,attempts=0;
  try{
   for(let round=0;round<this.maxToolRounds;round++){
    const message=await this.chat({model:worker.modelVersion,messages,tools,usageSink:addUsage});
    const calls=message?.tool_calls??[];
    if(!calls.length){output=typeof message?.content==='string'?message.content:JSON.stringify(message?.content??'');break;}
     messages.push({role:'assistant',content:message.content??'',tool_calls:calls});
     const pending=[];
     for(const call of calls){
      let args=null;try{args=JSON.parse(call.function?.arguments||'{}');}catch{args=null;}
      const checked=call.function?.name==='wiggly_tool'?ToolArguments.safeParse(args):{success:false,error:{message:`unknown tool ${call.function?.name}`}};
      if(!checked.success){messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(`TOOL_ARGUMENTS_INVALID: ${checked.error.message}`)});continue;}
      const parsed=checked.data;
      let toolTrace=null;try{toolTrace=this.tracer?.tool?.({toolName:parsed.name});}catch{toolTrace=null;}
      const toolStart=Date.now(),endTool=(outcome)=>{try{toolTrace?.end?.({outcome,durationMs:Date.now()-toolStart});}catch{}};
      try{
       const value=await callTool(parsed.name,{sha256:parsed.sha256,...(parsed.referenceSha256?{referenceSha256:parsed.referenceSha256}:{}),...(parsed.edit?{edit:parsed.edit}:{}),...(parsed.region?{region:parsed.region}:{})});
       endTool('completed');
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
        messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(JSON.stringify(compact))});
        if(!already){attached.add(key);pending.push({sha256:parsed.sha256,region:parsed.region??null,url:value.imageUrl});}
        continue;
       }
       messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(JSON.stringify(value.bytes?{file:value.file,...(/\.(json|md|txt)$/i.test(value.file.path)?{text:value.bytes.toString('utf8')}:{instruction:'Binary media: use your permitted perception tool.'})}:value))});
      }catch(error){endTool('failed');messages.push({role:'tool',tool_call_id:call.id,content:sanitizeDataUrls(error.message)});if(error.stopDispatch)throw error;}
     }
     if(pending.length){
      const parts=[];
      for(const p of pending)parts.push({type:'text',text:`viewImage result for sha256 ${p.sha256}${p.region?` region ${JSON.stringify(p.region)}`:''}`},{type:'image_url',image_url:{url:p.url}});
      messages.push({role:'user',content:parts});
     }
   }
   if(output==null)throw new Error(`OPENROUTER_TOOL_LIMIT: exceeded ${this.maxToolRounds} tool rounds without a final answer.`);
   try{return Event.parse(JSON.parse(JSON.parse(output).eventJson));}
   catch(error){
    attempts++;validationRetries=attempts;
    if(attempts>1)throw Object.assign(new Error(`INVALID_WORKER_EVENT: ${error.message}`),{knownFinished:true,finishedResult:output});
    messages.push({role:'assistant',content:output});
    messages.push({role:'user',content:`Your last reply failed validation: ${error.message}. Return ONLY {"eventJson": "<serialized Event>"} with the corrected event.`});
    const retry=await this.chat({model:worker.modelVersion,messages,tools,toolChoice:'none',usageSink:addUsage});
    const retryText=typeof retry?.content==='string'?retry.content:JSON.stringify(retry?.content??'');
    try{const event=Event.parse(JSON.parse(JSON.parse(retryText).eventJson));output=retryText;endTurn('completed');return event;}
    catch(error2){throw Object.assign(new Error(`INVALID_WORKER_EVENT: ${error2.message}`),{knownFinished:true,finishedResult:retryText});}
   }
  }finally{endTurn(output?'completed':'error');}
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
