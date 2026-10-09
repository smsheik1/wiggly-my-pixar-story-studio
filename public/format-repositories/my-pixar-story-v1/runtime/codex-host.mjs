import {loadStudio,limitsFor} from './instructions.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {z} from 'zod';
import {Content,Event,digest} from './contracts.mjs';
import {applyEvent} from './workflow.mjs';
import {crewRoles,runCrewTask,taskAssets} from './crew.mjs';
import {AudioEditPlan} from './audio-edit.mjs';

export const DEFAULT_WORKER_MODEL=loadStudio().config.agents['script-writer'].model;
// Explicit host profile: no model fallback, native shell, apps or nested worker dispatch.
const disabled=['shell_tool','unified_exec','apps','plugins','multi_agent','code_mode','browser_use','computer_use','view_image','image_generation','in_app_browser'];
// The local Code Mode host executes the registered scoped function tools even
// when the optional code_mode feature is off. Disabling it breaks every tool.
const enabled=['code_mode_host'];
const tool={type:'function',name:'wiggly_tool',description:'Call an allowed format tool on a hash from the current task. For renderAudioEdit supply edit with kind, keepRanges in fractional seconds and reason. Never read another path or submit a generation.',inputSchema:{type:'object',properties:{name:{type:'string'},sha256:{type:'string'},referenceSha256:{type:['string','null']},edit:{anyOf:[z.toJSONSchema(AudioEditPlan),{type:'null'}]},region:{anyOf:[{type:'object',description:'viewImage close-up crop in relative 0-1 coordinates',properties:{x:{type:'number'},y:{type:'number'},width:{type:'number'},height:{type:'number'}},required:['x','y','width','height'],additionalProperties:false},{type:'null'}]}},required:['name','sha256','referenceSha256'],additionalProperties:false}};

async function readJson(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function saveJson(path,value){await writeFile(path+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});await rename(path+'.tmp',path);}

// Failed-turn detail comes from the native turn error. Codex app-server
// reports {message, codexErrorInfo}, e.g. codexErrorInfo 'usageLimitExceeded'
// with "...try again at 9:34 PM." in the message; codexErrorInfo may also be an
// object keyed by its variant. Without error detail the cause is uncertain and
// the turn stays unreconciled.
function errorInfoName(error){
 const info=error?.codexErrorInfo;
 if(typeof info==='string')return info;
 if(info&&typeof info==='object')return Object.keys(info)[0]??'';
 return '';
}
function turnErrorDetail(turn){
 const error=turn?.error;
 if(error==null)return String(turn?.status??'unknown');
 if(typeof error==='string')return error.replace(/\.+$/,'');
 const name=errorInfoName(error)||error.code||error.type||'',message=String(error.message??'').trim().replace(/\.+$/,'');
 return (name&&message?`${name}: ${message}`:name||message)||JSON.stringify(error);
}
function turnRetryAfter(error){
 if(!error||typeof error!=='object')return null;
 for(const key of ['retryAfter','retry_after','resetsAt','resetAt'])if(error[key]!=null)return error[key];
 const said=/try again (?:at|in|after) ([^.]+?)\s*(?:\.|$)/i.exec(String(error.message??''));
 return said?said[1]:null;
}
function isUsageLimitFailure(turn,detail){
 const error=turn?.error,code=error&&typeof error==='object'?(errorInfoName(error)||error.code||error.type||''):'';
 return /usage.?limit|rate.?limit|too.?many.?requests|quota|\b429\b/i.test(`${code} ${detail}`);
}
function turnFailureMessage(turn){
 const detail=turnErrorDetail(turn);
 if(isUsageLimitFailure(turn,detail)){
  const after=turnRetryAfter(turn?.error);
  return after!=null?`Codex usage limit reached; retry after ${after}. No model/provider fallback was submitted.`:`Codex usage limit reached (${detail}). No model/provider fallback was submitted.`;
 }
 return `CODEX_TURN_FAILED: ${detail}. No model/provider fallback was submitted.`;
}

export class CodexHost {
 constructor({cwd,spawnProcess=spawn,timeoutMs=180000,onProgress=()=>{},perceptionTools={},perceptionProfile=null,tracer=null}={}){
  this.cwd=cwd;this.timeoutMs=timeoutMs;this.onProgress=onProgress;this.sequence=0;this.pending=new Map();this.active=null;this.perceptionProfile=perceptionProfile;this.tracer=tracer;
  this.child=spawnProcess('codex',['app-server','--stdio',...enabled.flatMap(name=>['--enable',name]),...disabled.flatMap(name=>['--disable',name]),'-c','web_search="disabled"'],{stdio:['pipe','pipe','pipe']});
  this.lines=createInterface({input:this.child.stdout});
  this.lines.on('line',line=>{try{this.message(JSON.parse(line));}catch(error){this.fail(error);}});
  // Do not print ambient host logs, credentials or media payloads.
  this.child.stderr.on('data',()=>{});
  this.child.on('error',error=>this.fail(error));
  this.child.on('exit',()=>this.fail(new Error('CODEX_HOST_EXITED: stopped; no task/provider retry was submitted.')));
  this.tools={...perceptionTools,viewImage:async({file})=>({perception:'direct-image',imageUrl:`data:image/${extname(file.path).slice(1).replace('jpg','jpeg')};base64,${(await readFile(file.path)).toString('base64')}`})};
 }
 send(value){this.child.stdin.write(JSON.stringify(value)+'\n');}
 call(method,params){return new Promise((resolve,reject)=>{const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CODEX_TIMEOUT: ${method}; stop and inspect the worker, never resubmit automatically.`));},this.timeoutMs);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
 fail(error){for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();this.active?.reject(error);}
 message(message){
  const entry=this.pending.get(message.id);
  if(entry){clearTimeout(entry.timer);this.pending.delete(message.id);message.error?entry.reject(new Error(`CODEX_HOST_ERROR: ${message.error.message}`)):entry.resolve(message.result);return;}
  if(this.active&&message.params?.threadId===this.active.threadId&&!this.active.turnId){this.active.buffer.push(message);return;}
  if(message.method==='item/tool/call'&&message.id!==undefined){const target=this.active;if(target)target.pendingTools=(target.pendingTools??0)+1;void Promise.resolve(this.toolCall(message)).finally(()=>{if(target)target.pendingTools=Math.max(0,(target.pendingTools??1)-1);});return;}
  if(message.id!==undefined){this.send({id:message.id,error:{code:-32601,message:'This client only permits the scoped format tool.'}});this.active?.reject(new Error('UNEXPECTED_HOST_REQUEST: human approvals and ambient actions are not delegated.'));return;}
  const active=this.active;if(!active||message.params?.threadId!==active.threadId||message.params?.turnId&&message.params.turnId!==active.turnId)return;
  if(message.method==='item/completed'&&message.params.item?.type==='agentMessage')active.output=message.params.item.text;
  if(message.method==='item/started')this.onProgress({worker:active.worker.name,item:message.params.item?.type});
   if(message.method==='turn/completed'){
    const turn=message.params.turn;
    if(turn.id!==active.turnId)return;
    if(turn.status!=='completed'){
     const error=new Error(turnFailureMessage(turn));
     error.turnStatus=turn.status;error.turnError=turn?.error??null;
     // A failed turn with native error detail that produced no final message
     // and left no tool call in progress is safe to retry; flag it so the
     // driver records the outcome instead of leaving the receipt started.
     // Anything else stays uncertain. Usage-limit failures are flagged
     // distinctly so the driver defers without consuming an attempt.
     const detail=turnErrorDetail(turn);
     if(turn.status==='failed'&&turn?.error!=null&&!active.output&&(active.pendingTools??0)===0){
      error.safeRetryWithoutOutput=true;
      error.savedTools=[...(active.finishedTools??[])];
      if(isUsageLimitFailure(turn,detail)){error.usageLimitExceeded=true;error.retryAfter=turnRetryAfter(turn?.error);}
     }
     active.reject(error);return;}
    active.resolve(active.output);
   }
 }
  async toolCall(message){
   const active=this.active,params=message.params;
   try{
    if(!active||params.threadId!==active.threadId||params.turnId!==active.turnId||params.tool!=='wiggly_tool')throw new Error('TOOL_SCOPE_DENIED');
    const arguments_=z.object({name:z.string(),sha256:z.string(),referenceSha256:z.string().nullable(),edit:AudioEditPlan.nullable().optional(),region:z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).strict().nullable().optional()}).strict().parse(params.arguments);
    let toolTrace=null;try{toolTrace=this.tracer?.tool?.({toolName:arguments_.name});}catch{toolTrace=null;}
    const toolStart=Date.now(),endTool=outcome=>{try{toolTrace?.end?.({outcome,durationMs:Date.now()-toolStart});}catch{}};
    let value;
    try{value=await active.callTool(arguments_.name,{sha256:arguments_.sha256,...(arguments_.referenceSha256?{referenceSha256:arguments_.referenceSha256}:{}),...(arguments_.edit?{edit:arguments_.edit}:{}),...(arguments_.region?{region:arguments_.region}:{})});}
    catch(error){endTool('failed');throw error;}
    endTool('completed');
    active.finishedTools??=[];active.finishedTools.push({type:'dynamicToolCall',status:'completed',tool:'wiggly_tool',arguments:{name:arguments_.name,sha256:arguments_.sha256,referenceSha256:arguments_.referenceSha256}});
    const contentItems=value.imageUrl?[{type:'inputText',text:JSON.stringify({fileSha256:arguments_.sha256,perception:value.perception})},{type:'inputImage',imageUrl:value.imageUrl}]:[{type:'inputText',text:JSON.stringify(value.bytes?{file:value.file,...(/\.(json|md|txt)$/i.test(value.file.path)?{text:value.bytes.toString('utf8')}:{instruction:'Binary media: use your permitted perception tool.'})}:value)}];
    this.send({id:message.id,result:{success:true,contentItems}});
   }catch(error){if(active&&!error.stopDispatch){active.finishedTools??=[];active.finishedTools.push({type:'dynamicToolCall',status:'failed',tool:'wiggly_tool'});}if(error.stopDispatch)this.active?.reject(error);this.send({id:message.id,result:{success:false,contentItems:[{type:'inputText',text:error.message}]}});}
  }
 async initialize(){await mkdir(this.cwd,{recursive:true});await this.call('initialize',{clientInfo:{name:'wiggly_memoir',title:'Wiggly memoir studio',version:'2.0.0'},capabilities:{experimentalApi:true}});this.send({method:'initialized',params:{}});}
 async profile(){
  const version=execFileSync('codex',['--version'],{encoding:'utf8'}).trim();
  return `${version}:${digest({sources:await Promise.all(['codex-host.mjs','crew.mjs','media.mjs','audio-edit.mjs','contracts.mjs','gemini-review.mjs','cartesia-stt.mjs','providers.mjs','evaluators.mjs','instructions.mjs'].map(name=>readFile(new URL(name,import.meta.url),'utf8'))),perception:this.perceptionProfile,enabled,disabled,tool})}`;
 }
 async startCrew(model,config=loadStudio().config){
  const capabilityVersion=await this.profile(),path=join(this.cwd,'crew-startup.json');
  const models=Object.fromEntries(Object.entries(config.agents).map(([role,a])=>[role,model??a.model]));
  const draft=await readJson(path)??{models,capabilityVersion,workers:[],pending:null};
  if(digest(draft.models??Object.fromEntries(Object.keys(crewRoles).map(r=>[r,draft.model])))!==digest(models)||draft.capabilityVersion!==capabilityVersion)throw new Error('CODEX_STARTUP_PROFILE_CHANGED: reconcile the recorded partial crew before changing model/tools.');
  if(draft.pending)throw new Error(`CODEX_STARTUP_UNCERTAIN: inspect ${path} and saved worker ${draft.pending.workerId??draft.pending.role}; initialization will not be repeated automatically.`);
  for(const [role,{name}] of Object.entries(config.agents)){
   const model=models[role];
   if(draft.workers.some(w=>w.role===role))continue;
   draft.pending={role};await saveJson(path,draft);
   let result;
   try{result=await this.call('thread/start',{model,allowProviderModelFallback:false,cwd:this.cwd,approvalPolicy:'never',sandbox:'read-only',environments:[],serviceName:'wiggly-memoir',dynamicTools:[tool],developerInstructions:`You are ${name}, the ${role} for the Wiggly memoir format. Complete only your assigned task. Use wiggly_tool for granted assets. Return only the requested structured event; never approve for the user, submit provider calls, or claim unavailable perception.`});}
   catch(error){if(error.message.startsWith('CODEX_HOST_ERROR:')){draft.pending=null;await saveJson(path,draft);}throw error;}
   draft.pending.workerId=result.thread.id;await saveJson(path,draft);
   if(result.model!==model)throw new Error('CODEX_MODEL_CHANGED: requested model must be used exactly.');
   const worker={workerId:result.thread.id,name,role,modelVersion:result.model,capabilityVersion,execution:'host'};
   const ready=await this.turn(worker,'Initialization only: acknowledge your assigned role by replying READY. Do not use tools, author a deliverable, or claim perception.');
   if(ready.trim()!=='READY')throw new Error(`CODEX_CREW_NOT_READY: ${name} initialization did not acknowledge the role.`);
   draft.workers.push(worker);draft.pending=null;await saveJson(path,draft);
  }
  return {workers:draft.workers};
 }
 async refreshCrew(crew){
  const capabilityVersion=await this.profile(),workers=[];
  for(const worker of crew.workers){
   const result=await this.call('thread/resume',{threadId:worker.workerId,model:worker.modelVersion,cwd:this.cwd,approvalPolicy:'never',sandbox:'read-only'});
   if(result.model!==worker.modelVersion||result.thread.id!==worker.workerId)throw new Error('CODEX_WORKER_CHANGED');
   workers.push({...worker,capabilityVersion});
  }
  return {workers};
 }

  // Preflight runs the checks that can fail before any turn starts, so the
  // driver can refuse before writing a started receipt. runTask keeps the
  // same checks as defense in depth.
  async preflight(worker){
   if(worker.capabilityVersion!==await this.profile())throw new Error('CODEX_PROFILE_CHANGED: host/tool version differs from the bound crew. Stop for explicit reconfiguration/qualification.');
   const resumed=await this.call('thread/resume',{threadId:worker.workerId,model:worker.modelVersion,cwd:this.cwd,approvalPolicy:'never',sandbox:'read-only'});
   if(resumed.model!==worker.modelVersion||resumed.thread.id!==worker.workerId)throw new Error('CODEX_WORKER_CHANGED');
  }
  async runTask(task,{worker,callTool}){
   if(this.active)throw new Error('CODEX_HOST_BUSY: one graph task at a time.');
   await this.preflight(worker);
  const contentSchema=Content[task.step]?z.toJSONSchema(Content[task.step]):null;
  if(task.step==='answers'){
   contentSchema.properties.sourceInputDigest.const=task.sourceInputDigest;
   contentSchema.properties.inputs.description='When task.originalInputsRequired is true, copy task.sourceInputs exactly, including all keys and original wording. Organize findings in commonSenseChecks; changes require recorded human clarification.';
  }
  if(task.step==='script'&&task.workflowRevision>=4)contentSchema.required=[...(contentSchema.required??[]),'proposedCast'];
  const input=JSON.stringify({instruction:'Complete ONLY this current task. Allowed action is review for review, owner-review for owner-review, plan for produce, otherwise artifact; narration/author and produce may also return an evidenced planning-blocked event. Never return runtime provider-error events. repairFeedback and savedTools describe HISTORICAL attempts, not a current tool failure. Continue the investigation with currently granted tools and compatible cached receipts; do not merely repeat a saved error. Saved narration edit output hashes are not automatically in scope after restart. To resume a saved draft, listen/inspect/transcribe its original current source as required, then call renderAudioEdit with that original source hash and the exact saved plan. This reuses its immutable local receipt, grants the draft hash in the current task, and does not create another draft. Then listen to the granted output before submitting. A current fatal tool failure is handled by the host and must not be fabricated from history. Source facts are in the supplied task. Do not invent facts, approval, tool evidence or perception. For a review, inspect every required criterion and return evidence and repairs, using your exact workerId/modelVersion/capabilityVersion. Missing capabilities mean inconclusive. Return eventJson containing the serialized Event object. Do not emit other text.',task:{...task,worker},contentSchema,eventSchema:z.toJSONSchema(Event)});
  const media=[];
  if((task.allowedTools??crewRoles[worker.role].tools).includes('viewImage'))for(const file of taskAssets(task).values())if(file.width&&!file.durationSeconds){const viewed=await callTool('viewImage',{sha256:file.sha256});media.push({type:'text',text:`Reference image sha256: ${file.sha256}`},{type:'image',url:viewed.imageUrl});}
  const output=await this.turn(worker,[{type:'text',text:input},...media],callTool,{type:'object',properties:{eventJson:{type:'string'}},required:['eventJson'],additionalProperties:false});
  try{return Event.parse(JSON.parse(JSON.parse(output).eventJson));}catch(error){throw Object.assign(new Error(`INVALID_WORKER_EVENT: ${error.message}`),{knownFinished:true,finishedResult:output});}
 }
 async turn(worker,input,callTool=async()=>{throw new Error('No tools are permitted during initialization.');},outputSchema){
  if(this.active)throw new Error('CODEX_HOST_BUSY: one graph task at a time.');
  let resolve,reject;const done=new Promise((yes,no)=>{resolve=yes;reject=no;});
   this.active={threadId:worker.workerId,worker,callTool,resolve,reject,output:'',buffer:[],pendingTools:0,finishedTools:[]};
  // Attach a handler immediately; a transport can fail before turn/start returns.
  done.catch(()=>{});
  const timer=setTimeout(()=>reject(new Error('CODEX_TURN_TIMEOUT: inspect saved worker progress; no automatic retry.')),this.timeoutMs);
  try{
   const started=await this.call('turn/start',{threadId:worker.workerId,input:Array.isArray(input)?input:[{type:'text',text:input}],...(outputSchema?{outputSchema}:{})});
   this.active.turnId=started.turn.id;for(const message of this.active.buffer.splice(0))this.message(message);
   return await done;
  }finally{clearTimeout(timer);this.active=null;}
 }
 close(){this.fail(new Error('CODEX_HOST_CLOSED'));this.child.stdin.end();this.child.kill();this.lines.close();}
}

// Reconciliation is a read of the original native turn, never a replacement turn.
export async function reconcileDispatch(task,host,{receiptDirectory,turnId,message}){
 const path=join(receiptDirectory,task.taskId+'.json'),receipt=await readJson(path);
 if(!message||!turnId||receipt?.status!=='started'||receipt.taskId!==task.taskId||receipt.workerDigest!==digest(task.crewWorker))throw new Error('DISPATCH_RECONCILIATION_DENIED: current started receipt, exact worker, turn ID and human direction required.');
 const result=await host.call('thread/read',{threadId:receipt.worker.workerId,includeTurns:true});
 const turn=result.thread?.turns?.find(t=>t.id===turnId);
 const input=turn?.items?.find(i=>i.type==='userMessage')?.content?.find(c=>c.type==='text')?.text;
 let packet;try{packet=JSON.parse(input);}catch{}
  // A failed turn with no final agent message and no tool call left in
  // progress never produced output, so it is as safe to retry as an
  // interrupted turn. The native error detail is required to record a clear
  // reason; without it the cause is uncertain and the turn stays refused, as
  // do failed turns with a final message or any in-flight tool call.
 const cleanFailed=turn?.status==='failed'&&turn?.error!=null;
 if(result.thread?.id!==receipt.worker.workerId||!(turn?.status==='interrupted'||cleanFailed)||turn.items.some(i=>i.type==='agentMessage')||turn.items.some(i=>i.type==='dynamicToolCall'&& !['completed','failed'].includes(i.status))||packet?.task?.taskId!==task.taskId||packet?.task?.worker?.workerId!==receipt.worker.workerId)throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: exact interrupted or clean-failed turn without a final result, pending tool or missing failure detail required; no retry permitted.');
 const failed=turn.status==='failed',detail=turnErrorDetail(turn);
 const usageLimit=failed&&isUsageLimitFailure(turn,detail);
 const archive=path+`.${usageLimit?'deferred':failed?'failed':'interrupted'}-${receipt.attempt}.json`,evidence=path+`.native-turn-${receipt.attempt}.json`;
 for(const [target,value] of [[archive,receipt],[evidence,turn]]){
  const prior=await readJson(target);if(prior&&digest(prior)!==digest(value))throw new Error('DISPATCH_RECEIPT_CONFLICT');
  if(!prior)await writeFile(target,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 }
 if(usageLimit){
  const reconciled={...receipt,status:'deferred',reason:'usage-limit',retryAfter:turnRetryAfter(turn?.error),error:`${turnFailureMessage(turn)} Continue the saved investigation; existing local draft and paid-call attempts remain consumed. Reuse compatible finished tool receipts; do not repeat invalid or unknown provider calls.`,event:{savedTools:turn.items.filter(i=>i.type==='dynamicToolCall')},reconciliation:{outcome:'confirmed-failed',turnId,message,evidencePath:evidence,at:new Date().toISOString()}};
  await saveJson(path,reconciled);return reconciled;
 }
 const reconciled={...receipt,status:'rejected',error:failed?`turn failed before producing output: ${detail}. Continue the saved investigation; existing local draft and paid-call attempts remain consumed. Reuse compatible finished tool receipts; do not repeat invalid or unknown provider calls.`:'Confirmed native interruption without final result. Continue the saved investigation; existing local draft and paid-call attempts remain consumed. Reuse compatible finished tool receipts; do not repeat invalid or unknown provider calls.',event:{savedTools:turn.items.filter(i=>i.type==='dynamicToolCall')},reconciliation:{outcome:failed?'confirmed-failed':'confirmed-interrupted',turnId,message,evidencePath:evidence,at:new Date().toISOString()}};
 await saveJson(path,reconciled);return reconciled;
}

// Explicit not-dispatched recovery for a stranded started receipt that has no
// Codex turn behind it (e.g. preflight refused before any turn started).
// Never modifies the receipt unless native thread/read proves no turn exists,
// is running, or references this task.
export async function reconcileNotDispatched(task,host,{receiptDirectory,message}){
 const path=join(receiptDirectory,task.taskId+'.json'),receipt=await readJson(path);
 if(typeof message!=='string'||!message.trim()||receipt?.status!=='started'||receipt.taskId!==task.taskId||receipt.workerDigest!==digest(task.crewWorker))throw new Error('DISPATCH_RECONCILIATION_DENIED: current started receipt, exact worker and human direction required.');
 if(receipt.turnId!=null||receipt.turn!=null||receipt.event!=null||receipt.reconciliation!=null)throw new Error('DISPATCH_RECONCILIATION_DENIED: receipt records a turn reference; use the --turn path.');
 let result;try{result=await host.call('thread/read',{threadId:receipt.worker.workerId,includeTurns:true});}catch{throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: native thread/read failed; no retry permitted.');}
 const thread=result?.thread;
 // Missing turns is not proof of no turns: a durable crew thread always has its READY turn.
 if(!thread||thread.id!==receipt.worker.workerId||!Array.isArray(thread.turns)||!thread.turns.length)throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: unexpected native thread; no retry permitted.');
 for(const turn of thread.turns){
  if(!turn||typeof turn.id!=='string'||typeof turn.status!=='string'||!Array.isArray(turn.items))throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: unexpected native turn; no retry permitted.');
  if(!['completed','interrupted','failed'].includes(turn.status))throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: a turn may still be running; no retry permitted.');
  for(const item of turn.items){
   if(item?.type!=='userMessage')continue;
   for(const part of item.content??[]){
    if(part?.type!=='text'||typeof part.text!=='string')continue;
    if(part.text.includes(task.taskId))throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: a native turn may reference this task; no retry permitted.');
    let packet;try{packet=JSON.parse(part.text);}catch{continue;}
    if(packet?.task?.taskId===task.taskId)throw new Error('DISPATCH_RECONCILIATION_UNCONFIRMED: a native turn references this task; no retry permitted.');
   }
  }
 }
 const archive=path+`.not-dispatched-${receipt.attempt}.json`,evidence=path+`.native-thread-${receipt.attempt}.json`;
 for(const [target,value] of [[archive,receipt],[evidence,thread]]){
  const prior=await readJson(target);if(prior&&digest(prior)!==digest(value))throw new Error('DISPATCH_RECEIPT_CONFLICT');
  if(!prior)await writeFile(target,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 }
 const reconciled={...receipt,status:'not-dispatched',reconciliation:{outcome:'confirmed-not-dispatched',message,evidencePath:evidence,at:new Date().toISOString()}};
 await saveJson(path,reconciled);return reconciled;
}

export async function driveCrew(workflow,thread,host,{maxTasks,receiptDirectory,repairInvalid=false,recoveryAttempt,verifySubmission=async()=>{},onProgress=()=>{},tracer=null}={}){
 maxTasks??=limitsFor((await workflow.status(thread)).project).crewTasksPerDispatch;
 if(!Number.isInteger(maxTasks)||maxTasks<1||maxTasks>32)throw new Error('Use a bounded maxTasks between 1 and 32.');
 if(!receiptDirectory)throw new Error('DISPATCH_RECEIPTS_REQUIRED: provide the run’s durable dispatch directory.');
 await mkdir(receiptDirectory,{recursive:true});
 let completed=0;
 while(completed<maxTasks){
  const status=await workflow.status(thread),task=status.pending;
  if(status.project.debug?.enabled&&status.project.debug.paused)return {completed,stop:'debug-pause',status};
  // Provider execution stays in the authorized runner; this loop never generates media.
  if(!['author','owner-review','review','produce'].includes(task.gate)||task.gate==='produce'&&task.step==='film'||['audioReviewerQualification','reviewerQualification'].includes(task.step))return {completed,stop:'graph-gate',status};
  onProgress({step:task.step,gate:task.gate});
   const path=join(receiptDirectory,task.taskId+'.json'),receipt=await readJson(path);
    if(receipt&&receipt.workerDigest!==digest(task.crewWorker)&&!((receipt.status==='rejected'||receipt.status==='deferred'||receipt.status==='not-dispatched')&&digest({...receipt.worker,capabilityVersion:null})===digest({...task.crewWorker,capabilityVersion:null})))throw new Error('DISPATCH_WORKER_CHANGED');
    if(receipt?.status==='started')throw new Error(`CODEX_DISPATCH_UNCERTAIN: inspect ${path} and the saved worker turn before reconciling. No automatic rerun.`);
    const attempt=(receipt?.status==='deferred'||receipt?.status==='not-dispatched')?(receipt.attempt||1):((receipt?.attempt??0)+(receipt?.status==='rejected'?1:0)||1);
    let event=receipt?.status==='completed'?receipt.event:null;
    // Preflight before any receipt write so a refused dispatch leaves no
    // stranded started receipt and never changes an existing receipt.
    if(!event&&typeof host.preflight==='function')await host.preflight(task.crewWorker);
    if(receipt?.status==='deferred'){
    if(receipt.reason!=='usage-limit')throw new Error(`CODEX_DISPATCH_UNKNOWN_DEFERRED: inspect ${path}.`);
    const archive=path+`.deferred-${receipt.attempt}.json`,prior=await readJson(archive);
    if(prior&&digest(prior)!==digest(receipt))throw new Error('DISPATCH_RECEIPT_CONFLICT');
    if(!prior)await writeFile(archive,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
   }
   if(receipt?.status==='rejected'){
    if(!repairInvalid)throw new Error(`CODEX_RESULT_REJECTED: ${receipt.error}; inspect ${path}; --repair-invalid true explicitly requests a bounded repair of the known finished result.`);
    if(attempt>limitsFor(status.project).finishedWorkerAttempts&&!(maxTasks===1&&recoveryAttempt?.taskId===task.taskId&&recoveryAttempt.attempt===attempt&&typeof recoveryAttempt.message==='string'&&recoveryAttempt.message.trim()))throw new Error('CODEX_REPAIR_LIMIT: configured finished-attempt limit exhausted; one further recovery attempt requires exact task/attempt and actual human authorization.');
    const archive=path+`.rejected-${receipt.attempt}.json`,prior=await readJson(archive);
    if(prior&&digest(prior)!==digest(receipt))throw new Error('DISPATCH_RECEIPT_CONFLICT');
    if(!prior)await writeFile(archive,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
   }
   // A not-dispatched receipt was already archived by reconciliation; the new
   // started receipt overwrites it at the same attempt without conflict.
   const started={status:'started',taskId:task.taskId,worker:task.crewWorker,workerDigest:digest(task.crewWorker),attempt,...(attempt>limitsFor(status.project).finishedWorkerAttempts?{recoveryAuthorization:{actor:'human',...recoveryAttempt,at:new Date().toISOString()}}:{})};
  if(!event){
   if(receipt)await saveJson(path,started);else await writeFile(path,JSON.stringify(started)+'\n',{flag:'wx',mode:0o600});
  }
  let turnTrace=null;try{turnTrace=tracer?.turn?.({role:task.crewWorker?.role,workerName:task.crewWorker?.name,model:task.crewWorker?.modelVersion,taskId:task.taskId,step:task.step,gate:task.gate,attempt});}catch{turnTrace=null;}
  const turnStart=Date.now();
  let traceEnded=false;
  const endTrace=outcome=>{if(traceEnded)return;traceEnded=true;try{turnTrace?.end?.({outcome,durationMs:Date.now()-turnStart});}catch{}};
  try{
   try{
    event=event?Event.parse(event):await runCrewTask(status.project,{...task,...(receipt?.status==='rejected'?{repairFeedback:{error:receipt.error,previousEvent:receipt.event,instruction:'Repair this evidenced validation error. Preserve current source facts and return the current gate Event.'}}:{})},host);
    applyEvent(status.project,event);
    // Validate actual referenced files before declaring a finished response reusable.
    // Recheck old completed receipts too; changed/missing bytes cannot trap repair.
    await verifySubmission(status,event);
    if(event.action==='review'||event.action==='owner-review')try{tracer?.review?.({decision:event.review?.decision,artifactId:event.artifactId});}catch{}
   }catch(error){
     // A clean usage-limit failure defers without consuming a finished-worker
     // attempt and retries with normal framing. Other clean native failures
     // record as rejected. Anything else stays uncertain.
     if(!event&&error?.safeRetryWithoutOutput){
      if(error?.usageLimitExceeded){
       endTrace('deferred-usage-limit');
       await saveJson(path,{...started,status:'deferred',reason:'usage-limit',retryAfter:error.retryAfter??null,error:error.message,event:{savedTools:error.savedTools??[]}});
       if(status.project.debug?.enabled)await workflow.respond(thread,{taskId:task.taskId,actor:'runtime',action:'debug-stop',message:error.message});
       throw error;
      }
      endTrace('rejected');
      await saveJson(path,{...started,status:'rejected',error:error.message,event:{savedTools:error.savedTools??[]}});
      if(status.project.debug?.enabled)await workflow.respond(thread,{taskId:task.taskId,actor:'runtime',action:'debug-stop',message:error.message});
      throw error;
     }
     if(!event&&!error.knownFinished){endTrace('error');if(status.project.debug?.enabled)await workflow.respond(thread,{taskId:task.taskId,actor:'runtime',action:'debug-stop',message:error.message});throw error;}
    endTrace('error');
    await saveJson(path,{...started,status:'rejected',event:event??error.finishedResult,error:error.message});
    if(status.project.debug?.enabled)await workflow.respond(thread,{taskId:task.taskId,actor:'runtime',action:'debug-stop',message:error.message});
    throw new Error(`CODEX_RESULT_REJECTED: known finished worker result violates the contract: ${error.message}. Inspect ${path}; use --repair-invalid true for a bounded repair.`);
   }
   await saveJson(path,{...started,status:'completed',event});
   const updated=await workflow.respond(thread,event);completed++;
   endTrace('completed');
  if(event.action==='review'&&event.review?.decision==='rejected'){const notice=updated.pending.repairNotices.find(n=>n.artifactId===event.artifactId);if(notice)onProgress({type:'repair-notice',notice});}
  }catch(e){endTrace('error');throw e;}finally{endTrace('error');}
 }
 const status=await workflow.status(thread);
 return {completed,stop:status.project.debug?.enabled&&status.project.debug.paused?'debug-pause':'task-limit',status};
}
