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

async function readJson(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function saveJson(path,value){await writeFile(path+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
async function readOpenRouterKey(secretsPath){
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
 constructor({cwd, secretsPath, model=DEFAULT_OPENROUTER_MODEL, timeoutMs=180000, reasoningEffort='medium', maxTokens=OPENROUTER_MAX_TOKENS, maxToolRounds=OPENROUTER_MAX_TOOL_ROUNDS, fetcher=fetch, perceptionTools={}, perceptionProfile=null, tracer=null}={}){
  if(['max','xhigh'].includes(reasoningEffort))throw new Error('OPENROUTER_REASONING_LIMIT: reasoning effort must be medium or high, never max/xhigh.');
  if(!['low','medium','high'].includes(reasoningEffort))throw new Error('OPENROUTER_REASONING_LIMIT: reasoning effort must be medium or high.');
  this.cwd=cwd??join(process.cwd(),'host-workspace');this.secretsPath=secretsPath;this.model=model;this.timeoutMs=timeoutMs;
  this.reasoningEffort=reasoningEffort;this.maxTokens=maxTokens;this.maxToolRounds=maxToolRounds;
  this.fetcher=fetcher;this.perceptionProfile=perceptionProfile;this.tracer=tracer;
  this.verifiedModels=new Set();
  this.tools={...perceptionTools,viewImage:async({file})=>({perception:'direct-image',imageUrl:`data:image/${extname(file.path).slice(1).replace('jpg','jpeg')};base64,${(await readFile(file.path)).toString('base64')}`})};
 }
 requestSettings(){
  return {model:this.model,provider:OPENROUTER_PROVIDER_POLICY,reasoning:{effort:this.reasoningEffort},max_tokens:this.maxTokens};
 }
 async profile(){
  const tool=wigglyToolDefinition();
  return digest({model:this.model,provider:OPENROUTER_PROVIDER_POLICY,reasoning:{effort:this.reasoningEffort},maxTokens:this.maxTokens,maxToolRounds:this.maxToolRounds,tool:tool.inputSchema,perception:this.perceptionProfile,instruction:'openrouter-crew-v1'});
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
  const forcingSpecificTool=toolChoice&&typeof toolChoice==='object';
  const body={model,messages,...(tools?.length?{tools,tool_choice:toolChoice??'auto'}:{}),provider:OPENROUTER_PROVIDER_POLICY,max_tokens:maxTokens??this.maxTokens,
   response_format:{type:'json_schema',json_schema:{name:'event',strict:true,schema:{type:'object',properties:{eventJson:{type:'string'}},required:['eventJson'],additionalProperties:false}}},
   // Thinking is switched off explicitly whenever a specific tool call is forced.
   reasoning:reasoning??(forcingSpecificTool?{enabled:false}:{effort:this.reasoningEffort})};
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
  const media=[];
  if((task.allowedTools??crewRoles[worker.role].tools).includes('viewImage'))for(const file of taskAssets(task).values())if(file.width&&!file.durationSeconds){const viewed=await callTool('viewImage',{sha256:file.sha256});media.push({type:'text',text:`Reference image sha256: ${file.sha256}`},{type:'image_url',image_url:{url:viewed.imageUrl}});}
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
    for(const call of calls){
     let args=null;try{args=JSON.parse(call.function?.arguments||'{}');}catch{args=null;}
     const checked=call.function?.name==='wiggly_tool'?ToolArguments.safeParse(args):{success:false,error:{message:`unknown tool ${call.function?.name}`}};
     if(!checked.success){messages.push({role:'tool',tool_call_id:call.id,content:`TOOL_ARGUMENTS_INVALID: ${checked.error.message}`});continue;}
     const parsed=checked.data;
     let toolTrace=null;try{toolTrace=this.tracer?.tool?.({toolName:parsed.name});}catch{toolTrace=null;}
     const toolStart=Date.now(),endTool=(outcome)=>{try{toolTrace?.end?.({outcome,durationMs:Date.now()-toolStart});}catch{}};
     try{
      const value=await callTool(parsed.name,{sha256:parsed.sha256,...(parsed.referenceSha256?{referenceSha256:parsed.referenceSha256}:{}),...(parsed.edit?{edit:parsed.edit}:{}),...(parsed.region?{region:parsed.region}:{})});
      endTool('completed');
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(value.bytes?{file:value.file,...(/\.(json|md|txt)$/i.test(value.file.path)?{text:value.bytes.toString('utf8')}:{instruction:'Binary media: use your permitted perception tool.'})}:value)});
     }catch(error){endTool('failed');messages.push({role:'tool',tool_call_id:call.id,content:error.message});if(error.stopDispatch)throw error;}
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
  await this.chat({model,messages:[{role:'user',content:'ping'}],reasoning:{enabled:false},maxTokens:16,verify:true});
  this.verifiedModels.add(model);
 }
 async startCrew(model,config=loadStudio().config){
  const capabilityVersion=await this.profile(),path=join(this.cwd,'crew-startup-openrouter.json');
  const openRoles=Object.entries(config.agents).filter(([,a])=>(a.backend??'codex')==='openrouter');
  const models=Object.fromEntries(openRoles.map(([role,a])=>[role,model??a.model]));
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
  const capabilityVersion=await this.profile();
  await this.verifyModel(agent.model);
  const workerId=`openrouter:${role}:${randomUUID().slice(0,8)}`;
  return {workerId,name:agent.name,role,modelVersion:agent.model,capabilityVersion,execution:'host',backend:'openrouter'};
 }
 close(){}
}
