import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadStudio} from '../runtime/instructions.mjs';
import {backendForAgent} from '../runtime/instructions.mjs';
import {buildWorkerPacket,crewRoles,workerBackend} from '../runtime/crew.mjs';
import {OpenRouterHost,DEFAULT_OPENROUTER_MODEL,OPENROUTER_PROVIDER_POLICY,OPENROUTER_MAX_TOKENS} from '../runtime/openrouter-host.mjs';
import {CrewHost} from '../runtime/crew-host.mjs';

const secrets=async(dir,key='ISOLATED-OPENROUTER-KEY')=>{const p=join(dir,'secrets.env');await writeFile(p,`OPENROUTER_API_KEY=${key}\n`);return p;};
const okResponse=(model,event)=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({eventJson:JSON.stringify(event)})}}]})});
const workerFor=cap=>({workerId:'openrouter:text-reviewer:test',name:'Sage',role:'text-reviewer',modelVersion:DEFAULT_OPENROUTER_MODEL,capabilityVersion:cap,backend:'openrouter'});
const scriptTask={step:'script',taskId:'isolated-task',actor:'agent',gate:'author',workflowRevision:2};
const scriptEvent={taskId:'isolated-task',actor:'agent',workerId:'openrouter:text-reviewer:test',action:'artifact',content:{beats:[]}};

test('studio pins Sol agents on codex and DeepSeek agents on openrouter',()=>{
 const agents=loadStudio().config.agents;
 for(const role of ['script-writer','pixar-prompter','visual-reviewer','scene-reviewer','background-product-owner']){
  assert.equal(agents[role].backend,'codex');assert.equal(agents[role].model,'gpt-6.1-sol');
 }
 for(const role of ['text-reviewer','cast-designer','sheet-prompter','shot-planner','composition-writer','motion-director','video-prompt-engineer','sound-designer','film-editor','audio-reviewer','generation-planner','voice-director']){
  assert.equal(agents[role].backend,'openrouter');assert.equal(agents[role].model,'deepseek/deepseek-v4.1-flash');
 }
});

test('loadStudio rejects unknown backends and missing models; legacy snapshots default to codex',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-backend-'));
 try{
  const kit=new URL('../',import.meta.url),current=loadStudio();
  const raw=JSON.parse(await readFile(new URL('studio.json',kit),'utf8'));
  raw.agents['script-writer'].backend='mystery';
  await writeFile(join(dir,'studio.json'),JSON.stringify(raw));
  for(const path of Object.keys(current.documents)){const {mkdir}=await import('node:fs/promises');const {dirname}=await import('node:path');await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),current.documents[path].content);}
  const {pathToFileURL}=await import('node:url');
  assert.throws(()=>loadStudio(pathToFileURL(dir+'/')),/backend|Unknown/i);
  // Legacy pinned studio without backend fields still loads; helpers treat it as codex.
  const legacy=structuredClone(current);for(const agent of Object.values(legacy.config.agents))delete agent.backend;
  assert.equal(backendForAgent(legacy.config.agents['script-writer']),'codex');
  assert.equal(workerBackend({role:'script-writer'}),'codex');
 }finally{await rm(dir,{recursive:true});}
});

test('openrouter uses the identical shared worker packet as codex',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-packet-'));
 try{
  const secretsPath=await secrets(dir);
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>{throw new Error('no network in packet test');}});
  const worker=workerFor(await host.profile());
  const packet=JSON.parse(buildWorkerPacket(scriptTask,worker));
  assert.match(packet.instruction,/Allowed action is review/);assert.match(packet.instruction,/HISTORICAL attempts/);
  assert.equal(packet.task.taskId,'isolated-task');assert.equal(packet.task.worker.workerId,worker.workerId);
  assert.ok(packet.contentSchema);assert.ok(packet.eventSchema);
  const source=await readFile(new URL('../runtime/codex-host.mjs',import.meta.url),'utf8');
  assert.match(source,/buildWorkerPacket/);
 }finally{await rm(dir,{recursive:true});}
});

test('runTask sends provider policy, json_schema wrapper, reasoning and token cap; key never in body',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-settings-'));
 try{
  const secretsPath=await secrets(dir,'ISOLATED-SECRET-ABC');
  const seen=[];const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{seen.push({url,init});return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);}});
  const worker=workerFor(await host.profile());
  const event=await host.runTask(scriptTask,{worker,callTool:async()=>{throw new Error('no tools needed');}});
  assert.equal(event.action,'artifact');
  assert.equal(seen.length,1);assert.equal(seen[0].url,'https://openrouter.ai/api/v1/chat/completions');
  const body=JSON.parse(seen[0].init.body);
  assert.deepEqual(body.provider,OPENROUTER_PROVIDER_POLICY);assert.equal(body.provider.require_parameters,true);assert.deepEqual(body.provider.max_price,{prompt:0.3,completion:1.2});
  assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.name,'event');
  assert.equal(body.reasoning.effort,'medium');assert.equal(body.max_tokens,OPENROUTER_MAX_TOKENS);
  assert.equal(body.model,DEFAULT_OPENROUTER_MODEL);
  assert.equal(body.tools[0].function.name,'wiggly_tool');assert.deepEqual(Object.keys(body.tools[0].function.parameters.properties).sort(),['edit','name','referenceSha256','region','sha256']);
  assert.match(String(seen[0].init.headers.Authorization),/Bearer ISOLATED-SECRET-ABC/);
  assert.ok(!JSON.stringify(body).includes('ISOLATED-SECRET-ABC'));
 }finally{await rm(dir,{recursive:true});}
});

test('runTask routes a wiggly_tool call through callTool and attaches image_url parts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-tools-'));
 try{
  const secretsPath=await secrets(dir);
  const calls=[];let n=0;const bodies=[];
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);bodies.push(body);n++;
   if(n===1){
    assert.ok(body.tools.length);
    return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'c1',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'readAsset',sha256:'a'.repeat(64),referenceSha256:null})}}]}}]})};
   }
   return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);
  }});
  const worker=workerFor(await host.profile());
  const refFile={path:'/tmp/ref.png',sha256:'b'.repeat(64),bytes:100,width:100,height:100};
  const task={...scriptTask,artifact:{content:{files:[refFile]}}};
  const event=await host.runTask(task,{worker,callTool:async(name,params)=>{calls.push({name,params});if(name==='viewImage')return {perception:'direct-image',imageUrl:'data:image/png;base64,ISOLATED'};return {file:{path:'/tmp/note.txt'},bytes:Buffer.from('hello world tool output here')};}});
  assert.equal(event.action,'artifact');
  assert.ok(calls.some(c=>c.name==='viewImage'&&c.params.sha256===refFile.sha256));
  assert.ok(calls.some(c=>c.name==='readAsset'));
  const imageParts=bodies[0].messages[1].content.filter(p=>p.type==='image_url');
  assert.equal(imageParts.length,1);assert.equal(imageParts[0].image_url.url,'data:image/png;base64,ISOLATED');
  assert.equal(n,2);
  assert.deepEqual(calls.find(c=>c.name==='readAsset'),{name:'readAsset',params:{sha256:'a'.repeat(64)}});
 }finally{await rm(dir,{recursive:true});}
});

test('model mismatch throws MODEL_CHANGED; missing key stops before any turn',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-model-'));
 try{
  const secretsPath=await secrets(dir);
  let fetches=0;
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>{fetches++;return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:'someone-else/model',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({eventJson:JSON.stringify(scriptEvent)})}}]})};}});
  const worker=workerFor(await host.profile());
  await assert.rejects(host.runTask(scriptTask,{worker,callTool:async()=>{}}),/MODEL_CHANGED/);
  const noKey=new OpenRouterHost({cwd:dir,secretsPath:join(dir,'missing.env'),fetcher:async()=>{fetches++;throw new Error('must not fetch');}});
  await assert.rejects(noKey.runTask(scriptTask,{worker:workerFor(await noKey.profile()),callTool:async()=>{}}),/OPENROUTER_API_KEY missing/);
  assert.equal(fetches,1);
 }finally{await rm(dir,{recursive:true});}
});

test('402 maps to credits-exhausted; 429 maps to usage-limit retry semantics',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-http-'));
 try{
  const secretsPath=await secrets(dir);
  const mk=(status)=>new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>({ok:false,status,headers:{get:()=>null},text:async()=>''})});
  const w42=workerFor(await mk(402).profile());
  await assert.rejects(mk(402).runTask(scriptTask,{worker:w42,callTool:async()=>{}}),/credits exhausted/);
  const h429=mk(429),w429=workerFor(await h429.profile());
  await assert.rejects(h429.runTask(scriptTask,{worker:w429,callTool:async()=>{}}),e=>e.safeRetryWithoutOutput===true&&e.usageLimitExceeded===true);
 }finally{await rm(dir,{recursive:true});}
});

test('exactly one retry on invalid worker JSON, then INVALID_WORKER_EVENT with knownFinished',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-retry-'));
 try{
  const secretsPath=await secrets(dir);let n=0;
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>{n++;return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"eventJson": "not json"}'}}]})};}});
  const worker=workerFor(await host.profile());
  await assert.rejects(host.runTask(scriptTask,{worker,callTool:async()=>{}}),e=>/INVALID_WORKER_EVENT/.test(e.message)&&e.knownFinished===true);
  assert.equal(n,2);
 }finally{await rm(dir,{recursive:true});}
});

test('READY init turn accepts bare or eventJson-wrapped acknowledgement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-ready-'));
 try{
  const secretsPath=await secrets(dir);
  for(const content of ['READY',JSON.stringify({eventJson:'READY'})]){
   const host=new OpenRouterHost({cwd:join(dir,content.length>10?'a':'b'),secretsPath,fetcher:async()=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'stop',message:{role:'assistant',content}}]})})});
   const worker=await host.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL});
   assert.equal(worker.modelVersion,DEFAULT_OPENROUTER_MODEL);assert.match(worker.workerId,/^openrouter:text-reviewer:/);
  }
 }finally{await rm(dir,{recursive:true});}
});
test('preflight refuses a stale capabilityVersion; profile digests model, settings, tool and perception',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-preflight-'));
 try{
  const secretsPath=await secrets(dir);
  const a=new OpenRouterHost({cwd:dir,secretsPath,perceptionProfile:{media:'A'}});
  const b=new OpenRouterHost({cwd:dir,secretsPath,perceptionProfile:{media:'B'}});
  assert.notEqual(await a.profile(),await b.profile());
  const worker=workerFor('stale');
  await assert.rejects(a.preflight(worker),/PROFILE_CHANGED/);
 }finally{await rm(dir,{recursive:true});}
});

test('router sends Sol workers to codex and DeepSeek workers to openrouter; refresh rebinds only changed roles',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-router-'));
 try{
  const secretsPath=await secrets(dir);
  const seen=[];
  const codex={tools:{},preflight:async()=>{},runTask:async()=>{seen.push('codex');return {ok:'codex'};},refreshCrew:async(c)=>({workers:c.workers}),startRole:async()=>{throw new Error('unused');}};
  const openrouter=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>{throw new Error('unused');}});
  openrouter.refreshCrew=async(c)=>({workers:c.workers});
  openrouter.startRole=async(role,agent)=>({workerId:`openrouter:${role}:rebound`,name:agent.name,role,modelVersion:agent.model,capabilityVersion:'new-cap',execution:'host',backend:'openrouter'});
  const config=loadStudio().config;
  const host=new CrewHost({codex,openrouter,config});
  const codexWorker={workerId:'codex-x',name:'Leo',role:'script-writer',modelVersion:'gpt-6.1-sol',capabilityVersion:'c',execution:'host',backend:'codex'};
  const orWorker={workerId:'or-x',name:'Sage',role:'text-reviewer',modelVersion:DEFAULT_OPENROUTER_MODEL,capabilityVersion:'c',execution:'host',backend:'openrouter'};
  await host.runTask(scriptTask,{worker:codexWorker,callTool:async()=>{}});
  assert.deepEqual(seen,['codex']);
  const crew={workers:[
   {...codexWorker,modelVersion:'gpt-6.1-sol'},
   {...orWorker,modelVersion:'gpt-6.1-sol'},
  ]};
  const out=await host.refreshCrew(crew,config);
  assert.deepEqual(out.changed,['text-reviewer']);
  assert.ok(out.workers.find(w=>w.role==='script-writer').workerId==='codex-x');
  assert.match(out.workers.find(w=>w.role==='text-reviewer').workerId,/rebound/);
 }finally{await rm(dir,{recursive:true});}
});
