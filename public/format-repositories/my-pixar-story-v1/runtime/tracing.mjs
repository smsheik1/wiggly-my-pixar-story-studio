import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';

export const TRACING_PROJECT='wiggly-my-pixar-story';

function sha256Hex(bytes){return createHash('sha256').update(bytes).digest('hex');}
function isBase64Blob(s){
 if(typeof s!=='string'||s.length<64)return false;
 // Hex digests (sha256 etc.) are safe identifiers, not media payloads.
 if(/^[0-9a-f]{64,128}$/i.test(s))return false;
 if(s.length>200000)return true;
 return /^[A-Za-z0-9+/=_-]+$/.test(s.slice(0,2048))&&/^[A-Za-z0-9+/]+={0,2}$/.test(s.slice(0,512))&&s.length%4===0;
}

// Allowlist-style sanitizer: only digests/basenames for media, never bytes,
// base64, data: URLs, private paths, or secret values. Ported from
// scripts/studio-spike/tracing.ts redact() with stricter coverage.
export function sanitize(value,secrets=[]){
 const scrubSecrets=s=>{
  if(typeof s!=='string'||!s)return s;
  let out=s;
  for(const secret of secrets)if(secret&&secret.length>=4&&out.includes(secret))out=out.split(secret).join('[REDACTED]');
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
    key,/key|token|secret|authorization|password|api[_-]?key|x-goog-api-key|xi-api-key/i.test(key)?'[REDACTED]':clean(child),
   ]));
  }
  return input;
 };
 return clean(value);
}
export const redact=value=>sanitize(value);

function extractValue(source,name){
 const match=source.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.+)\\s*$`,'m'));
 if(!match)return null;
 const value=match[1].trim().replace(/^(['"])(.*)\1$/,'$2');
 return value||null;
}

function disabledTracer(){
 const noop={end(){}};
 return {enabled:false,projectName:TRACING_PROJECT,runId:null,turn:()=>noop,tool:()=>noop,review:()=>{},paidJob:()=>{},flush:async()=>{}};
}

let warned=false;
function warnOnce(message){
 if(warned)return;warned=true;
 try{process.stderr.write(`tracing disabled for this run: ${String(message).slice(0,160)}\n`);}catch{}
}

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

export async function createTracer({secretsPath,runId='local',projectName=TRACING_PROJECT,client=null,fetcher=fetch,tags:extraTags=[],metadata:extraMetadata={}}={}){
 if(process.env.WIGGLY_TRACING==='off')return disabledTracer();
 if(!secretsPath)return disabledTracer();
 let source;
 try{source=await readFile(secretsPath,'utf8');}catch{return disabledTracer();}
 const apiKey=extractValue(source,'LANGSMITH_API_KEY');
 if(!apiKey)return disabledTracer();
 // Every value in the secrets file is scrubbed, not only known key names.
 const secrets=[apiKey];
 for(const match of source.matchAll(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+?)\s*$/gm)){
  const value=match[1].replace(/^(['"])(.*)\1$/,'$2');
  if(value&&value.length>=8)secrets.push(value);
 }
 const tags=[`run:${runId}`,...(Array.isArray(extraTags)?extraTags:[])];
 const baseMetadata={runId,...(extraMetadata&&typeof extraMetadata==='object'?extraMetadata:{})};
 const safe=(value)=>{try{return sanitize(value,secrets);}catch{return {sanitize_failed:true};}};
 if(client){
  // Injected fake backend for tests: capture sanitized runs, never network.
  const captured=client.captured??(client.captured=[]);
  const post=run=>{try{captured.push(run);}catch(error){warnOnce(error.message);}};
  const root={name:'drive-codex',run_type:'chain',project_name:projectName,tags,inputs:safe(baseMetadata),metadata:safe(baseMetadata)};
  post({phase:'root',...root});
  const open=new Set();
  const child=(kind,fields)=>{
   const run={phase:kind,project_name:projectName,tags,metadata:safe({...baseMetadata,...fields}),...safe(fields)};
   post(run);
   const handle={...run,ended:false,end:(outputs={})=>{if(handle.ended)return;handle.ended=true;open.delete(handle);try{post({phase:`${kind}-end`,tags,...safe(outputs)});}catch(error){warnOnce(error.message);}}};
   open.add(handle);
   return handle;
  };
  return {
   enabled:true,projectName,runId,captured,
   turn:(fields={})=>child('crew-turn',{name:`crew-turn:${fields.role??'unknown'}`,run_type:'chain',...fields}),
   tool:(fields={})=>child('tool',{name:`tool:${fields.toolName??'unknown'}`,run_type:'tool',...fields}),
   review:(fields={})=>{child('review',{name:'review-verdict',run_type:'chain',...fields}).end({});},
   paidJob:(fields={})=>{
    const {outcome='ok',durationMs=0,jobId,provider,estimatedCostUsd,actualCostUsd,error,...rest}=fields;
    child('paid-job',{name:`paid-job:${fields.provider??'unknown'}`,run_type:'tool',...fields})
      .end({outcome,durationMs,jobId,provider,estimatedCostUsd,actualCostUsd,...rest,...(error?{error}:{})});
   },
   flush:async()=>{for(const handle of [...open])try{handle.end({outcome:'error',error:'unfinished at flush'});}catch(error){warnOnce(error.message);}},
  };
 }
 // Live backend: minimal langsmith Client + RunTree usage.
 try{
  const {Client}=await import('langsmith');
  const {RunTree}=await import('langsmith/run_trees');
  const ls=new Client({apiKey,callerOptions:{maxRetries:0},timeout_ms:10000,hideInputs:value=>safe(value),hideOutputs:value=>safe(value),hideMetadata:value=>safe(value),fetchImplementation:fetcher});
  const root=new RunTree({name:'drive-codex',run_type:'chain',inputs:safe(baseMetadata),project_name:projectName,tags,metadata:safe(baseMetadata),client:ls});
  root.postRun().catch(error=>warnOnce(error.message));
  const open=new Set();
  const child=(name,run_type,fields)=>{
   try{
    const tree=new RunTree({name,run_type,parent_run:root,inputs:safe(fields),project_name:projectName,tags,metadata:safe({...baseMetadata,...fields}),client:ls});
    tree.postRun().catch(error=>warnOnce(error.message));
    // RunTree.end() only records locally; patchRun() sends the end time/outputs.
    const handle={ended:false,end:(outputs={},errorText)=>{if(handle.ended)return;handle.ended=true;open.delete(handle);try{Promise.resolve(tree.end(safe(outputs),errorText)).then(()=>tree.patchRun()).catch(error=>warnOnce(error.message));}catch(error){warnOnce(error.message);}}};
    open.add(handle);
    return handle;
   }catch(error){warnOnce(error.message);return {ended:true,end(){}};}
  };
  let flushed=false;
  return {
   enabled:true,projectName,runId,
   turn:(fields={})=>child(`crew-turn:${fields.role??'unknown'}`,'chain',fields),
   tool:(fields={})=>child(`tool:${fields.toolName??'unknown'}`,'tool',fields),
   review:(fields={})=>{child('review-verdict','chain',fields).end({decision:fields.decision,artifactId:fields.artifactId});},
   paidJob:(fields={})=>{
    const {outcome='ok',durationMs=0,jobId,provider,estimatedCostUsd,actualCostUsd,error,...rest}=fields;
    const errorText = outcome !== 'ok' ? (error || 'paid-job error') : undefined;
    child(`paid-job:${fields.provider??'unknown'}`,'tool',fields)
      .end({outcome,durationMs,jobId,provider,estimatedCostUsd,actualCostUsd,...rest,...(error?{error}:{})}, errorText);
   },
   flush:async(timeoutMs=5000)=>{
    if(flushed)return;flushed=true;
    for(const handle of [...open])try{handle.end({outcome:'error',error:'unfinished at flush'},'unfinished at flush');}catch(error){warnOnce(error.message);}
    let timer;
    try{await Promise.race([(async()=>{await root.end(safe({runId}));await root.patchRun();await ls.awaitPendingTraceBatches();})(),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs);timer.unref?.();})]);}
    catch(error){warnOnce(error.message);}
    finally{clearTimeout(timer);}
   },
  };
 }catch(error){warnOnce(error.message);return disabledTracer();}
}
