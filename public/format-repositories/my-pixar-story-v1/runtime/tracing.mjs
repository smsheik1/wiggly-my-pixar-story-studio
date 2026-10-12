import {readFile, mkdir, appendFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {basename, join} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';

export const TRACING_PROJECT='wiggly-my-pixar-story';

export const DEFAULT_LIMITS={
  maxStringChars:64_000,
  packetMaxChars:200_000,
  maxArrayItems:200,
  maxDepth:12,
  maxRunBytes:25*1024*1024,
};

function sha256Hex(bytes){
  if(typeof bytes==='string')return createHash('sha256').update(bytes,'utf8').digest('hex');
  return createHash('sha256').update(bytes).digest('hex');
}
function isBase64Blob(s){
 if(typeof s!=='string'||s.length<64)return false;
 // Hex digests (sha256 etc.) are safe identifiers, not media payloads.
 if(/^[0-9a-f]{64,128}$/i.test(s))return false;
 if(s.length>200000)return true;
 return /^[A-Za-z0-9+/=_-]+$/.test(s.slice(0,2048))&&/^[A-Za-z0-9+/]+={0,2}$/.test(s.slice(0,512))&&s.length%4===0;
}

// Token-usage counters (input_tokens, reasoningTokens, promptTokenCount,
// output_token_details, ...) are numbers, not credentials: keep them readable.
export function isUsageCountKey(key){
 return /tokens?(_?details|_?count)?$/i.test(key)&&/(input|output|total|reasoning|cached|cache_write|prompt|completion|candidates|thoughts?|max|audio|video|image)/i.test(key);
}
// Allowlist-style sanitizer: only digests/basenames for media, never bytes,
// base64, data: URLs, private paths, or secret values. Ported from
// scripts/studio-spike/tracing.ts redact() with stricter coverage.
export function sanitize(value,secrets=[]){
 const scrubSecrets=s=>{
  if(typeof s!=='string'||!s)return s;
  let out=s;
  for(const secret of secrets)if(secret&&secret.length>=4&&out.includes(secret))out=out.split(secret).join('[REDACTED]');
  // Bearer tokens and shaped provider keys anywhere in strings.
  out=out.replace(/Bearer\s+[A-Za-z0-9._~+\/-=]+/g,'Bearer [REDACTED]');
  out=out.replace(/sk-or-[A-Za-z0-9\-_]{4,}/g,'[REDACTED]');
  out=out.replace(/lsv2_[A-Za-z0-9_\-]{4,}/g,'[REDACTED]');
  return out;
 };
 const clean=input=>{
  if(typeof input==='string'){
   const trimmed=input.trim();
   if(/^data:.*;base64,/.test(trimmed)){
    const bytes=Buffer.from(trimmed.slice(trimmed.indexOf(',')+1), 'base64');
    return {media_omitted:true,sha256:sha256Hex(bytes),bytes:bytes.length};
   }
   if(/^data:/.test(trimmed))return {media_omitted:true,format:'data-url-omitted'};
   if(isBase64Blob(trimmed))return {media_omitted:true,sha256:sha256Hex(Buffer.from(trimmed.slice(0,4096))),bytes:trimmed.length};
   // Private file paths: basename only, never directories.
   if(/(\/|[A-Za-z]:\\).+\.(png|jpe?g|webp|mp4|mov|wav|mp3|m4a|flac|ogg|aiff?)$/i.test(trimmed))return basename(trimmed);
   if(trimmed.includes('/private')||trimmed.includes('wiggly-private'))return basename(trimmed);
   return scrubSecrets(input);
  }
  if(Buffer.isBuffer(input))return {media_omitted:true,sha256:sha256Hex(input),bytes:input.length};
  if(input instanceof Uint8Array)return {media_omitted:true,sha256:sha256Hex(Buffer.from(input)),bytes:input.length};
  if(Array.isArray(input))return input.map(clean);
  if(input&&typeof input==='object'){
   if(['image','video','audio'].includes(input.type)&&typeof input.data==='string'){
    const bytes=Buffer.from(input.data, 'base64');
    const {data:_data,...metadata}=input;
    return {...clean(metadata),data:{media_omitted:true,sha256:sha256Hex(bytes),bytes:bytes.length}};
   }
   return Object.fromEntries(Object.entries(input).map(([key,child])=>[
    key,(!isUsageCountKey(key)&&/key|token|secret|authorization|password|api[_-]?key|x-goog-api-key|xi-api-key/i.test(key))?'[REDACTED]':clean(child),
   ]));
  }
  return input;
 };
 return clean(value);
}
export const redact=value=>sanitize(value);

// Bound large payloads: strings cut with sha marker, arrays cut with marker, depth cap.
export function bound(value, limits={}){
  const maxStringChars=limits.maxStringChars??DEFAULT_LIMITS.maxStringChars;
  const packetMaxChars=limits.packetMaxChars??DEFAULT_LIMITS.packetMaxChars;
  const maxArrayItems=limits.maxArrayItems??DEFAULT_LIMITS.maxArrayItems;
  const maxDepth=limits.maxDepth??DEFAULT_LIMITS.maxDepth;
  const rec=(v,depth,key)=>{
    if(depth>maxDepth)return '…[truncated max-depth]';
    if(typeof v==='string'){
      const limit=key==='packet'?packetMaxChars:maxStringChars;
      if(v.length>limit){
        const cut=v.length-limit;
        const sha=sha256Hex(v).slice(0,12);
        return v.slice(0,limit)+`…[truncated ${cut} chars, sha256 ${sha}]`;
      }
      return v;
    }
    if(Array.isArray(v)){
      let arr=v;
      let truncated=0;
      if(arr.length>maxArrayItems){truncated=arr.length-maxArrayItems;arr=arr.slice(0,maxArrayItems);}
      const out=arr.map(item=>rec(item,depth+1,key));
      if(truncated)out.push(`…[truncated ${truncated} items]`);
      return out;
    }
    if(v&&typeof v==='object'){
      const out={};
      for(const [k,child] of Object.entries(v))out[k]=rec(child,depth+1,k);
      return out;
    }
    return v;
  };
  try{return rec(value,0,null);}catch{return {bound_failed:true};}
}

// Failure reason code: the first UPPER_SNAKE code in the message (CREW_PERMISSION_DENIED,
// INVALID_WORKER_EVENT, OPENROUTER_REQUEST_FAILED, ...). Plain words like "HTTP" are not codes.
export function reasonCode(messageOrError){
  try{
    const isObj=messageOrError&&typeof messageOrError==='object';
    if(isObj&&messageOrError.usageLimitExceeded)return 'OPENROUTER_RATE_LIMITED';
    const msg=String(isObj?(messageOrError.message??''):(messageOrError??''));
    if(/OpenRouter usage limit reached|HTTP 429/i.test(msg))return 'OPENROUTER_RATE_LIMITED';
    if(/credits exhausted/i.test(msg))return 'OPENROUTER_CREDITS_EXHAUSTED';
    const m=msg.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
    return m?m[0]:null;
  }catch{return null;}
}

export function labelFor(worker){
  try{
    if(worker?.name&&worker?.role)return `${worker.name}, ${worker.role}`;
    return worker?.role??'unknown';
  }catch{return 'unknown';}
}

export function promptSectionsFor(task){
  try{
    if(!task||typeof task!=='object')return [];
    const out=[];
    if(task.skill&&typeof task.skill==='object'){
      out.push({id:task.skill.path??'skill',kind:'skill',path:task.skill.path??'skill',sha256:task.skill.sha256??null,chars:typeof task.skill.content==='string'?task.skill.content.length:(task.skill.chars??0)});
    }
    if(Array.isArray(task.craft)){
      const craftPath=task.studioConfig?.craft?.path??'craft-guide.md';
      for(const entry of task.craft){
        if(!entry||typeof entry!=='object')continue;
        out.push({id:entry.id??'craft',kind:'craft',path:entry.path??`${craftPath}#${entry.id??''}`,sha256:entry.sha256??null,chars:typeof entry.content==='string'?entry.content.length:(entry.chars??0)});
      }
    }
    if(task.stepGuide&&typeof task.stepGuide==='object'){
      out.push({id:task.stepGuide.path??'stepGuide',kind:'stepGuide',path:task.stepGuide.path??'stepGuide',sha256:task.stepGuide.sha256??null,chars:typeof task.stepGuide.content==='string'?task.stepGuide.content.length:(task.stepGuide.chars??0)});
    }
    if(task.reviewerRubricSource&&typeof task.reviewerRubricSource==='object'){
      out.push({id:task.reviewerRubricSource.path??'reviewerRubric',kind:'reviewerRubric',path:task.reviewerRubricSource.path??'reviewerRubric',sha256:task.reviewerRubricSource.sha256??null,chars:typeof task.reviewerRubric==='string'?task.reviewerRubric.length:0});
    }else if(typeof task.reviewerRubric==='string'&&task.reviewerRubric.length){
      out.push({id:'reviewerRubric',kind:'reviewerRubric',path:'reviewerRubric',sha256:sha256Hex(task.reviewerRubric),chars:task.reviewerRubric.length});
    }
    if(task.recipe&&typeof task.recipe==='object'){
      const content=typeof task.recipe.content==='string'?task.recipe.content:'';
      out.push({id:task.recipe.path??'recipe',kind:'recipe',path:task.recipe.path??'recipe',sha256:task.recipe.sha256??(content?sha256Hex(content):null),chars:content.length});
    }
    if(task.communication&&typeof task.communication==='object'){
      out.push({id:task.communication.path??'communication',kind:'communication',path:task.communication.path??'communication',sha256:task.communication.sha256??null,chars:typeof task.communication.content==='string'?task.communication.content.length:(task.communication.chars??0)});
    }
    return out;
  }catch{return [];}
}

export function journalPathFor(runDir){
  return join(runDir,'trace','trace.jsonl');
}

function extractValue(source,name){
 const match=source.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)\\s*$`,'m'));
 if(!match)return null;
 const value=match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
 return value||null;
}

function disabledTracer(){
 const noop={id:'noop',parentId:null,kind:'noop',name:'noop',ended:true,end(){},child(){return {id:'noop',parentId:null,ended:true,end(){},child(){return this;}};}};
 const noopFn=()=>noop;
 return {enabled:false,journaling:false,projectName:TRACING_PROJECT,runId:null,runDir:null,rootName:'disabled',turn:noopFn,agentCall:noopFn,llm:noopFn,tool:noopFn,review(){},paidJob(){},child:noopFn,within:(h,fn)=>fn(),current:()=>null,flush:async()=>{},getRunUrl:async()=>null};
}

let warned=false;
function warnOnce(message){
 if(warned)return;warned=true;
 try{process.stderr.write(`tracing disabled for this run: ${String(message).slice(0,160)}\n`);}catch{}
}
export function _resetWarnedForTests(){warned=false;}

// Optional live tracing: enabled only when LANGSMITH_API_KEY is present in the
// canonical --secrets file and WIGGLY_TRACING is not 'off'. Never reads chat.
// Pass {client} to inject a fake backend (tests, no network). All methods are
// sync fire-and-forget; only flush() is awaited with a bounded timeout and it
// never throws into the runtime.
export function paidJobTimer(tracer, base = {}) {
  const startAt = Date.now();
  return {
    ok(extra = {}) {
      try {
        const durationMs = Date.now() - startAt;
        const outcome = 'ok';
        tracer?.paidJob?.({
          ...base,
          ...extra,
          outcome,
          durationMs,
        });
      } catch {}
    },
    fail(error, extra = {}) {
      try {
        const durationMs = Date.now() - startAt;
        const errorMsg = String(error?.message ?? error ?? '').slice(0, 300);
        const isQuota = /resource_exhausted|exhausted your capacity|quota will reset/i.test(errorMsg)
          || /\bHTTP (402|429)\b|_CREDITS_EXHAUSTED|_RATE_LIMITED/.test(errorMsg)
          || error?.status === 402 || error?.status === 429;
        const outcome = isQuota ? 'quota' : 'provider-error';
        tracer?.paidJob?.({
          ...base,
          ...extra,
          outcome,
          error: errorMsg,
          durationMs,
        });
      } catch {}
    },
  };
}

const SMALL_KEYS=new Set(['role','label','workerName','workerId','model','modelVersion','backend','taskId','step','gate','attempt','outcome','durationMs','error','reasonCode','reason','requests','inputTokens','outputTokens','reasoningTokens','cachedTokens','costUsd','input_tokens','output_tokens','name','toolName','tool','provider','jobId','estimatedCostUsd','actualCostUsd','actualCostSource','decision','artifactId','kind','id','parentId','status','operation','generationId','promptCount','completionCount','promptTokens','completionTokens','validationRetries','budgetExhausted','phase','ts','attempts','continuation','cached','tokens']);
// Run metadata stays small: scalar ids/labels/costs only, plus an explicit
// fields.metadata object (e.g. ls_provider/ls_model_name for llm runs).
function metadataFor(base,fields){
  const out={...base};
  try{
    for(const [k,v] of Object.entries(fields??{})){
      if(k==='metadata'||k==='name'||k==='run_type')continue;
      if(v===null||['string','number','boolean'].includes(typeof v)){if(typeof v==='string'&&v.length>300)continue;out[k]=v;}
    }
    if(fields?.metadata&&typeof fields.metadata==='object')Object.assign(out,fields.metadata);
  }catch{}
  return out;
}
function stripToSmall(fields){
  const out={};
  try{
    for(const [k,v] of Object.entries(fields??{})){
      if(!SMALL_KEYS.has(k))continue;
      if(typeof v==='string'&&v.length>1000)continue;
      if(v!==null&&typeof v==='object')continue;
      out[k]=v;
    }
  }catch{}
  out.budgetExhausted=true;
  return out;
}

export async function createTracer({secretsPath,runId='local',runDir=null,rootName=null,name=null,projectName=TRACING_PROJECT,client=null,fetcher=fetch,tags:extraTags=[],metadata:extraMetadata={},limits={}}={}){
 if(process.env.WIGGLY_TRACING==='off')return disabledTracer();
 const effLimits={...DEFAULT_LIMITS,...(limits||{})};
 const envBytes=process.env.WIGGLY_TRACE_MAX_BYTES?Number(process.env.WIGGLY_TRACE_MAX_BYTES):null;
 if(Number.isFinite(envBytes)&&envBytes>0)effLimits.maxRunBytes=envBytes;
 const resolvedRootName=rootName??name??'drive-codex';
 // Read secrets file if given; missing file means no key (journal may still apply).
 let source='';
 let secretsPathOk=false;
 if(secretsPath){
  try{source=await readFile(secretsPath,'utf8');secretsPathOk=true;}catch{source='';secretsPathOk=false;}
 }else{
  // No secrets path: no key, but journal may still be wanted when runDir given.
  source='';
 }
 const apiKey=extractValue(source,'LANGSMITH_API_KEY');
 // Every value in the secrets file is scrubbed, not only known key names.
 const secrets=apiKey?[apiKey]:[];
 if(secretsPathOk){
  for(const match of source.matchAll(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/gm)){
   const value=match[1].replace(/^(['"])(.*)\1$/,'$2');
   if(value&&value.length>=8)secrets.push(value);
  }
 }
 const tags=[`run:${runId}`,...(Array.isArray(extraTags)?extraTags:[])];
 const baseMetadata={runId,...(extraMetadata&&typeof extraMetadata==='object'?extraMetadata:{})};
 const journaling=!!runDir;
 // If no backend and no journal, stay disabled (preserves old behaviour for missing key).
 // When runDir is given we journal even without a key.
 if(!apiKey&&!client&&!journaling)return disabledTracer();
 if(!apiKey&&!journaling)return disabledTracer();
 const safe=(value)=>{
  try{
    const s=sanitize(value,secrets);
    return bound(s,effLimits);
  }catch{return {sanitize_failed:true};}
 };
 // Journal setup (async queued, errors swallowed, byte cap applies).
 let journalPath=null;
 let journalQueue=Promise.resolve();
 let journalBytes=0;
 const als=new AsyncLocalStorage();
 let byteUsed=0;
 let budgetWarned=false;
 const noteBytes=(n)=>{byteUsed+=n;journalBytes+=n;};
 const overBudget=()=>byteUsed>=effLimits.maxRunBytes;
 const maybeStrip=(fields)=>{
   if(!overBudget())return {fields,stripped:false};
   if(!budgetWarned){budgetWarned=true;warnOnce(`trace budget exhausted at ${byteUsed} bytes (cap ${effLimits.maxRunBytes}); keeping small fields only`);}
   return {fields:stripToSmall(fields),stripped:true};
 };
 if(journaling&&runDir){
  journalPath=journalPathFor(runDir);
  try{await mkdir(join(runDir,'trace'),{recursive:true});}catch(error){warnOnce(error.message);}
 }
 const appendJournal=(entry)=>{
  if(!journalPath)return;
  const line=JSON.stringify(entry)+'\n';
  noteBytes(Buffer.byteLength(line));
  journalQueue=journalQueue.then(async()=>{
    try{await mkdir(join(runDir,'trace'),{recursive:true});await appendFile(journalPath,line,{mode:0o600});}catch(error){warnOnce(error.message);}
  }).catch(()=>{});
 };
 // ID space
 let seq=0;
 // Session prefix: several commands (drive, generate, collect) append to one run journal.
 const session=randomUUID().slice(0,8);
 const nextId=()=>`${session}-${++seq}`;
 // Root handle (no parent)
 const rootId=`root-${session}`;
 const open=new Set();
 let rootTree=null;
 let lsClient=null;
 let useLive=false;
 let captured=null;
 let postFake=null;
 if(client){
  captured=client.captured??(client.captured=[]);
  postFake=(run)=>{try{captured.push(run);}catch(error){warnOnce(error.message);}};
  // Root start for fake backend (compat phase 'root', name rootName)
  try{
    const rootFields=safe(baseMetadata);
    const rs=maybeStrip(rootFields);
    postFake({phase:'root',id:rootId,parentId:null,kind:'root',name:resolvedRootName,run_type:'chain',project_name:projectName,tags,inputs:rs.fields,metadata:rs.fields,...(rs.stripped?{budgetExhausted:true}:{})});
    noteBytes(JSON.stringify(rootFields).length);
  }catch(error){warnOnce(error.message);}
 }
 // Live backend init (only when apiKey present and no fake client)
 if(apiKey&&!client){
  try{
   const {Client}=await import('langsmith');
   const {RunTree}=await import('langsmith/run_trees');
   lsClient=new Client({apiKey,callerOptions:{maxRetries:0},timeout_ms:10000,hideInputs:value=>safe(value),hideOutputs:value=>safe(value),hideMetadata:value=>safe(value),fetchImplementation:fetcher});
   // The client forces 4 retries with exponential backoff on its internal callers, which kept a
   // run's process alive ~70 s at exit when LangSmith was unreachable. Tracing must never slow a run.
   for(const caller of [lsClient.caller,lsClient.batchIngestCaller])try{if(caller&&'maxRetries' in caller)caller.maxRetries=0;}catch{}
   rootTree=new RunTree({name:resolvedRootName,run_type:'chain',inputs:safe(baseMetadata),project_name:projectName,tags,metadata:safe(baseMetadata),client:lsClient});
   rootTree.postRun().catch(error=>warnOnce(error.message));
   useLive=true;
  }catch(error){warnOnce(error.message);useLive=false;rootTree=null;lsClient=null;}
 }
 if(journalPath)appendJournal({ts:new Date().toISOString(),id:rootId,parentId:null,phase:'start',kind:'root',name:resolvedRootName,fields:safe({...baseMetadata,tags})});
 const rootHandle={id:rootId,parentId:null,kind:'root',name:resolvedRootName,run_type:'chain',ended:false,tree:rootTree,
   child:(kind,fields)=>makeChild(kind,fields,rootHandle),
   end:(outputs={},errorText)=>{/* root ends on flush */}};
 const resolveParent=(explicitParent,defaultToRoot=true)=>{
   if(explicitParent)return explicitParent;
   try{const cur=als.getStore();if(cur)return cur;}catch{}
   return defaultToRoot?rootHandle:null;
 };
 const emitStart=({id,parentId,kind,runName,runType,fields})=>{
   const s=safe(fields);
   const {fields:effFields,stripped}=maybeStrip(s);
   const size=JSON.stringify(effFields).length;
   noteBytes(size);
   const ts=new Date().toISOString();
   // Journal (phase start|end)
   if(journalPath){
     appendJournal({ts,id,parentId,phase:'start',kind,name:runName,fields:effFields,...(stripped?{budgetExhausted:true}:{})});
   }
   // Backend
   if(postFake){
     try{postFake({phase:kind,id,parentId,kind,name:runName,run_type:runType,project_name:projectName,tags,metadata:safe(metadataFor(baseMetadata,effFields)),...effFields,...(stripped?{budgetExhausted:true}:{})});}catch(error){warnOnce(error.message);}
   }else if(useLive&&lsClient){
     // live trees are created by caller with parent linkage; nothing extra here
   }
   return effFields;
 };
 const emitEnd=({id,parentId,kind,outputs,errorText})=>{
   const s=safe(outputs||{});
   const {fields:effFields,stripped}=maybeStrip(s);
   const size=JSON.stringify(effFields).length;
   noteBytes(size);
   const ts=new Date().toISOString();
   if(journalPath){
     appendJournal({ts,id,parentId,phase:'end',kind,name:kind,fields:{...effFields,...(errorText?{errorText}:{})},...(stripped?{budgetExhausted:true}:{})});
   }
   if(postFake){
     try{postFake({phase:`${kind}-end`,id,parentId,kind,tags,...effFields,...(errorText?{errorText}:{}),...(stripped?{budgetExhausted:true}:{})});}catch(error){warnOnce(error.message);}
   }
 };
 function makeChild(kind,fields={},explicitParent=null){
   const parent=resolveParent(explicitParent,true)??rootHandle;
   const id=nextId();
   const parentId=parent?.id??rootHandle.id;
   // Derive run name / type per kind (compat with existing phases).
   let runName='unknown';
   let runType='chain';
   if(kind==='crew-turn'){runName=`crew-turn:${fields.role??'unknown'}`;runType='chain';}
   else if(kind==='agent-call'){runName=`agent-call:${fields.role??'unknown'}`;runType='chain';}
   else if(kind==='llm'){runName=`llm:${fields.model??fields.inputs?.model??'unknown'}`;runType='llm';}
   else if(kind==='tool'){runName=`tool:${fields.toolName??fields.name??'unknown'}`;runType='tool';}
   else if(kind==='review'){runName='review-verdict';runType='chain';}
   else if(kind==='review-verdict'){runName='review-verdict';runType='chain';kind='review';}
   else if(kind==='paid-job'){runName=`paid-job:${fields.provider??'unknown'}`;runType='tool';}
   else if(kind==='root'){runName=resolvedRootName;runType='chain';}
   else{runName=fields.name??kind;runType=fields.run_type??'chain';}
   const effKind=kind==='review-verdict'?'review':kind;
   emitStart({id,parentId,kind:effKind,runName,runType,fields:{name:runName,run_type:runType,...fields}});
   let tree=null;
   if(useLive&&lsClient&&rootTree){
     try{
       // Dynamic import already done; reuse RunTree class via rootTree constructor
       const RunTreeClass=rootTree.constructor;
       const parentTree=parent?.tree??rootTree;
       const s=safe({name:runName,run_type:runType,...fields});
       const {fields:treeFields}=maybeStrip(s);
       tree=new RunTreeClass({name:runName,run_type:runType,parent_run:parentTree,inputs:treeFields,project_name:projectName,tags,metadata:safe(metadataFor(baseMetadata,treeFields)),client:lsClient});
       tree.postRun().catch(error=>warnOnce(error.message));
     }catch(error){warnOnce(error.message);tree=null;}
   }
   const handle={id,parentId,kind:effKind,name:runName,run_type:runType,ended:false,tree,
     child:(k,f)=>makeChild(k,f,handle),
     end:(outputs={},errorText)=>{
       if(handle.ended)return;handle.ended=true;open.delete(handle);
       emitEnd({id,parentId,kind:effKind,outputs,errorText});
       if(tree){
         try{Promise.resolve(tree.end(safe(outputs||{}),errorText)).then(()=>tree.patchRun()).catch(error=>warnOnce(error.message));}catch(error){warnOnce(error.message);}
       }
     }};
   open.add(handle);
   return handle;
 }
 const within=(handle,fn)=>{
   if(!handle)return fn();
   // Never run fn twice: only fall back when als.run itself failed before fn started.
   let started=false;
   try{return als.run(handle,()=>{started=true;return fn();});}
   catch(error){if(started)throw error;return fn();}
 };
 const current=()=>{
   try{return als.getStore()??null;}catch{return null;}
 };
 const childGeneric=(kind,fields)=>makeChild(kind,fields,null);
 let flushed=false;
 const flush=async(timeoutMs=5000)=>{
   if(flushed&&useLive)return;
   // End still-open children (compat: unfinished at flush)
   for(const handle of [...open]){
     try{handle.end({outcome:'error',error:'unfinished at flush'},'unfinished at flush');}catch(error){warnOnce(error.message);}
   }
   // Wait for journal queue bounded
   let timer=null;
   try{
     await Promise.race([
       (async()=>{
         try{await journalQueue;}catch(error){warnOnce(error.message);}
         if(useLive&&lsClient&&rootTree){
           try{await rootTree.end(safe({runId}));await rootTree.patchRun();await lsClient.awaitPendingTraceBatches();}catch(error){warnOnce(error.message);}
         }
       })(),
       new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);timer.unref?.();}),
     ]);
   }catch(error){warnOnce(error.message);}
   finally{if(timer)clearTimeout(timer);flushed=true;}
 };
 const getRunUrl=async()=>{
   try{
     if(useLive&&lsClient&&typeof lsClient.getRunUrl==='function'&&rootTree?.id){
       return await lsClient.getRunUrl({runId:rootTree.id,projectName});
     }
     if(useLive&&rootTree?.id)return `https://smith.langchain.com/projects/${encodeURIComponent(projectName)}/runs/${encodeURIComponent(rootTree.id)}`;
     return null;
   }catch{return null;}
 };
 const isFakeEnabled=!!(postFake&&apiKey);
 const isLiveEnabled=useLive;
 const tracer={
   enabled:!!(isFakeEnabled||isLiveEnabled),
   journaling:journaling&&process.env.WIGGLY_TRACING!=='off',
   projectName,runId,runDir,rootName:resolvedRootName,tags,metadata:baseMetadata,
   journalPath,
   ...(captured?{captured}:{}),
   within,current,child:childGeneric,
   turn:(fields={})=>makeChild('crew-turn',{name:`crew-turn:${fields.role??'unknown'}`,run_type:'chain',...fields},rootHandle),
   agentCall:(fields={})=>makeChild('agent-call',{name:`agent-call:${fields.role??'unknown'}`,run_type:'chain',...fields},null),
   llm:(fields={})=>makeChild('llm',{name:`llm:${fields.model??fields.inputs?.model??'unknown'}`,run_type:'llm',...fields},null),
   tool:(fields={})=>makeChild('tool',{name:`tool:${fields.toolName??fields.name??'unknown'}`,run_type:'tool',...fields},null),
   review:(fields={})=>{const h=makeChild('review',{name:'review-verdict',run_type:'chain',...fields},null);try{h.end({decision:fields.decision,artifactId:fields.artifactId});}catch(error){warnOnce(error.message);}},
   paidJob:(fields={})=>{
     const {outcome='ok',durationMs=0,jobId,provider,estimatedCostUsd,actualCostUsd,error,...rest}=fields;
     const h=makeChild('paid-job',{name:`paid-job:${fields.provider??'unknown'}`,run_type:'tool',...fields},null);
     try{
       const errorText=outcome!=='ok'?(error||'paid-job error'):undefined;
       h.end({outcome,durationMs,jobId,provider,estimatedCostUsd,actualCostUsd,...rest,...(error?{error}:{})},errorText);
     }catch(error2){warnOnce(error2.message);}
   },
   flush,getRunUrl,
 };
 // Compat aliases
 tracer['agent-call']=tracer.agentCall;
 // Fake backend without a key still captures (tests inject fake); enabled stays false
 // to signal "LangSmith is off", matching the no-key journal-only rule.
 return tracer;
}
