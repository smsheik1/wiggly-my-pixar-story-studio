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
const verifyOk=(model,content='pong')=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({model,choices:[{finish_reason:'stop',message:{role:'assistant',content}}]})});
const httpFail=(status,text='boom')=>({ok:false,status,headers:{get:()=>null},text:async()=>text});
const echoFetcher=(seen)=>async(url,init)=>{const body=JSON.parse(init.body);if(seen)seen.push(body);return verifyOk(body.model);};
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

test('startRole binds the worker without a READY handshake',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-bind-'));
 try{
  const secretsPath=await secrets(dir);
  for(const content of ['garbage','']){
   const bodies=[];
   const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{bodies.push(JSON.parse(init.body));return verifyOk(DEFAULT_OPENROUTER_MODEL,content);}});
   const worker=await host.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL});
   assert.equal(worker.modelVersion,DEFAULT_OPENROUTER_MODEL);assert.match(worker.workerId,/^openrouter:text-reviewer:[0-9a-f]{8}$/);
   assert.equal(worker.name,'Sage');assert.equal(worker.role,'text-reviewer');
   assert.equal(worker.execution,'host');assert.equal(worker.backend,'openrouter');assert.ok(worker.capabilityVersion);
   assert.ok(!JSON.stringify(bodies).match(/READY|acknowledge/));
  }
 }finally{await rm(dir,{recursive:true});}
});

test('binding sends no READY/acknowledge prompt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-noready-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:echoFetcher(bodies)});
  await host.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL});
  await host.startCrew(undefined,{agents:{'text-reviewer':{name:'Sage',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL}}});
  assert.ok(bodies.length>=1);
  assert.ok(!JSON.stringify(bodies).match(/READY|acknowledge/));
 }finally{await rm(dir,{recursive:true});}
});

test('startCrew checks each distinct model exactly once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-once-'));
 try{
  const secretsPath=await secrets(dir);
  let n=0;
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{n++;return verifyOk(JSON.parse(init.body).model);}});
  const out=await host.startCrew(undefined,{agents:{'text-reviewer':{name:'Sage',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL},'cast-designer':{name:'Cee',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL},'sheet-prompter':{name:'Ess',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL}}});
  assert.equal(n,1);assert.equal(out.workers.length,3);
 }finally{await rm(dir,{recursive:true});}
});

test('verifyModel caches per model on the host instance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-cache-'));
 try{
  const secretsPath=await secrets(dir);
  let n=0;
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{n++;return verifyOk(JSON.parse(init.body).model);}});
  await host.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL});
  await host.startRole('cast-designer',{name:'Cee',model:DEFAULT_OPENROUTER_MODEL});
  assert.equal(n,1);
  await host.startRole('sheet-prompter',{name:'Ess',model:'other/model'});
  assert.equal(n,2);
 }finally{await rm(dir,{recursive:true});}
});

test('verify uses a minimal body; runTask bodies are unchanged',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-bodies-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{const body=JSON.parse(init.body);bodies.push(body);return body.tools?.length?okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent):verifyOk(body.model);}});
  await host.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL});
  const worker=workerFor(await host.profile());
  await host.runTask(scriptTask,{worker,callTool:async()=>{throw new Error('no tools needed');}});
  const [verify,task]=bodies;
  assert.deepEqual(verify.reasoning,{enabled:false});assert.ok(verify.max_tokens<=16);
  assert.ok(!('tools' in verify)&&!('tool_choice' in verify));
  assert.equal(verify.provider.require_parameters,true);
  assert.equal(task.reasoning.effort,'medium');assert.equal(task.max_tokens,OPENROUTER_MAX_TOKENS);
 }finally{await rm(dir,{recursive:true});}
});

test('auth and model failures are explicit and never leak the key',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-fail-'));
 try{
  const secretsPath=await secrets(dir,'SUPER-SECRET-KEY-XYZ');
  const badKey=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>httpFail(401,'invalid api key')});
  await assert.rejects(badKey.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL}),e=>/OPENROUTER_AUTH_FAILED/.test(e.message)&&!e.message.includes('SUPER-SECRET-KEY-XYZ'));
  const badModel=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>httpFail(400,'no such model')});
  await assert.rejects(badModel.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL}),/OPENROUTER_MODEL_UNAVAILABLE/);
  const noKey=new OpenRouterHost({cwd:dir,secretsPath:join(dir,'missing.env'),fetcher:async()=>{throw new Error('must not fetch');}});
  await assert.rejects(noKey.startRole('text-reviewer',{name:'Sage',model:DEFAULT_OPENROUTER_MODEL}),/OPENROUTER_API_KEY missing/);
 }finally{await rm(dir,{recursive:true});}
});

test('failed verification records nothing; a rerun binds every role',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-recover-a-'));
 try{
  const secretsPath=await secrets(dir);
  const cfg={agents:{'text-reviewer':{name:'Sage',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL},'cast-designer':{name:'Cee',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL}}};
  const failing=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>httpFail(500,'transient')});
  await assert.rejects(failing.startCrew(undefined,cfg),/OPENROUTER_REQUEST_FAILED/);
  let saved=null;try{saved=JSON.parse(await readFile(join(dir,'crew-startup-openrouter.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  assert.ok(!saved||saved.workers.length===0);
  const good=new OpenRouterHost({cwd:dir,secretsPath,fetcher:echoFetcher()});
  const out=await good.startCrew(undefined,cfg);
  assert.equal(out.workers.length,2);
  const reread=JSON.parse(await readFile(join(dir,'crew-startup-openrouter.json'),'utf8'));
  assert.equal(reread.pending,null);assert.equal(reread.workers.length,2);
 }finally{await rm(dir,{recursive:true});}
});

test('stale startup file with pending recovers without edits',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-recover-b-'));
 try{
  const secretsPath=await secrets(dir);
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:echoFetcher()});
  const cap=await host.profile();
  const cfg={agents:{'text-reviewer':{name:'Sage',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL},'cast-designer':{name:'Cee',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL}}};
  await writeFile(join(dir,'crew-startup-openrouter.json'),JSON.stringify({models:{'text-reviewer':DEFAULT_OPENROUTER_MODEL,'cast-designer':DEFAULT_OPENROUTER_MODEL},capabilityVersion:cap,workers:[{workerId:'openrouter:text-reviewer:deadbeef',name:'Sage',role:'text-reviewer',modelVersion:DEFAULT_OPENROUTER_MODEL,capabilityVersion:'stale-cap',execution:'host',backend:'openrouter'}],pending:{role:'text-reviewer',workerId:'openrouter:text-reviewer:deadbeef'}}));
  const out=await host.startCrew(undefined,cfg);
  assert.equal(out.workers.length,2);
  assert.ok(out.workers.find(w=>w.role==='text-reviewer').workerId!=='openrouter:text-reviewer:deadbeef');
  const reread=JSON.parse(await readFile(join(dir,'crew-startup-openrouter.json'),'utf8'));
  assert.equal(reread.pending,null);assert.equal(reread.workers.length,2);
 }finally{await rm(dir,{recursive:true});}
});

test('matching saved worker keeps its workerId',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-recover-c-'));
 try{
  const secretsPath=await secrets(dir);
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:echoFetcher()});
  const cap=await host.profile();
  const cfg={agents:{'text-reviewer':{name:'Sage',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL},'cast-designer':{name:'Cee',backend:'openrouter',model:DEFAULT_OPENROUTER_MODEL}}};
  await writeFile(join(dir,'crew-startup-openrouter.json'),JSON.stringify({models:{'text-reviewer':DEFAULT_OPENROUTER_MODEL,'cast-designer':DEFAULT_OPENROUTER_MODEL},capabilityVersion:cap,workers:[{workerId:'openrouter:text-reviewer:kept1234',name:'Sage',role:'text-reviewer',modelVersion:DEFAULT_OPENROUTER_MODEL,capabilityVersion:cap,execution:'host',backend:'openrouter'}],pending:null}));
  const out=await host.startCrew(undefined,cfg);
  assert.equal(out.workers.length,2);
  assert.equal(out.workers.find(w=>w.role==='text-reviewer').workerId,'openrouter:text-reviewer:kept1234');
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

test('malformed tool arguments go back to the model; tool-less requests omit tools; forced tools switch thinking off; usage is traced without token-named keys',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-args-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[],ends=[];let n=0;
  const tracer={turn:()=>({end:o=>ends.push(o)}),tool:()=>({end(){}})};
  const host=new OpenRouterHost({cwd:dir,secretsPath,tracer,fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);bodies.push(body);n++;
   const usage={prompt_tokens:10,completion_tokens:5,cost:0.001};
   if(n===1)return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,usage,choices:[{message:{role:'assistant',content:'',tool_calls:[{id:'bad',type:'function',function:{name:'wiggly_tool',arguments:'{"name":"readAsset"'}}]}}]})};
   return {...okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent),json:async()=>({model:DEFAULT_OPENROUTER_MODEL,usage,choices:[{message:{role:'assistant',content:JSON.stringify({eventJson:JSON.stringify(scriptEvent)})}}]})};
  }});
  const worker=workerFor(await host.profile());
  const calls=[];
  const event=await host.runTask(scriptTask,{worker,callTool:async(name)=>{calls.push(name);throw new Error('should not run');}});
  assert.equal(event.action,'artifact');assert.deepEqual(calls,[]);
  assert.match(bodies[1].messages.find(m=>m.role==='tool').content,/TOOL_ARGUMENTS_INVALID/);
  assert.equal(ends.length,1);assert.deepEqual(ends[0].usage,{requests:2,promptCount:20,completionCount:10,costUsd:0.002});
  await host.chat({model:DEFAULT_OPENROUTER_MODEL,messages:[],tools:[]});
  assert.equal('tools' in bodies.at(-1),false);assert.equal('tool_choice' in bodies.at(-1),false);
  await host.chat({model:DEFAULT_OPENROUTER_MODEL,messages:[],tools:host.toolDefinition(),toolChoice:{type:'function',function:{name:'wiggly_tool'}}});
  assert.deepEqual(bodies.at(-1).reasoning,{enabled:false});
  assert.equal(JSON.stringify(bodies).includes('ISOLATED-OPENROUTER-KEY'),false);
 }finally{await rm(dir,{recursive:true});}
});

test('a task-turn HTTP 400/401 keeps the generic request error (bind-time names are verify-only)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-task400-'));
 try{
  const secretsPath=await secrets(dir);
  for(const status of [400,401]){
   const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async()=>httpFail(status,'bad request')});
   const worker=workerFor(await host.profile());
   await assert.rejects(host.runTask(scriptTask,{worker,callTool:async()=>{}}),e=>new RegExp(`OPENROUTER_REQUEST_FAILED: HTTP ${status}`).test(e.message)&&!/MODEL_UNAVAILABLE|AUTH_FAILED/.test(e.message));
  }
 }finally{await rm(dir,{recursive:true});}
});

test('viewImage result on a new image sends compact tool text plus one image_url part',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-view-new-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];let n=0;
  const sha='c'.repeat(64),imageUrl='data:image/png;base64,'+'A'.repeat(5000);
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);bodies.push(body);n++;
   if(n===1)return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'v1',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'viewImage',sha256:sha})}}]}}]})};
   return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);
  }});
  const worker=workerFor(await host.profile());
  await host.runTask(scriptTask,{worker,callTool:async(name)=>{assert.equal(name,'viewImage');return {perception:'direct-image',imageUrl};}});
  assert.equal(bodies.length,2);
  const msgs=bodies[1].messages;
  const toolIdx=msgs.findIndex(m=>m.role==='tool');
  assert.ok(toolIdx>0);
  assert.equal(msgs[toolIdx-1].role,'assistant');
  const toolContent=msgs[toolIdx].content;
  assert.ok(!toolContent.includes('base64')&&!toolContent.includes('data:'));
  assert.ok(toolContent.length<1000);
  const follow=msgs[toolIdx+1];
  assert.equal(follow?.role,'user');
  const parts=Array.isArray(follow.content)?follow.content:[];
  const images=parts.filter(p=>p.type==='image_url');
  assert.equal(images.length,1);
  assert.equal(images[0].image_url.url,imageUrl);
  assert.ok(parts[0].type==='text'&&parts[0].text.includes(sha));
 }finally{await rm(dir,{recursive:true});}
});

test('viewImage result on an already-attached image resends no bytes and says alreadyAttached',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-view-dedupe-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];let n=0;
  const sha='d'.repeat(64),imageUrl='data:image/png;base64,ISOLATED-REF';
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);bodies.push(body);n++;
   if(n===1)return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'v2',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'viewImage',sha256:sha})}}]}}]})};
   return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);
  }});
  const worker=workerFor(await host.profile());
  const task={...scriptTask,artifact:{content:{files:[{path:'/tmp/ref.png',sha256:sha,bytes:100,width:100,height:100}]}}};
  await host.runTask(task,{worker,callTool:async()=>({perception:'direct-image',imageUrl})});
  assert.equal(bodies.length,2);
  const countImages=(msgs)=>msgs.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length;
  assert.equal(countImages(bodies[0].messages),1);
  assert.equal(countImages(bodies[1].messages),1);
  const tool=msgs=>msgs.find(m=>m.role==='tool');
  const content=tool(bodies[1].messages).content;
  assert.match(content,/alreadyAttached/);
  assert.ok(!content.includes('base64')&&!content.includes('data:'));
 }finally{await rm(dir,{recursive:true});}
});

test('re-viewing a large attached image does not double the request body',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-view-size-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];let n=0;
  const sha='e'.repeat(64),imageUrl='data:image/png;base64,'+'B'.repeat(2*1024*1024);
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{
   bodies.push(JSON.parse(init.body));n++;
   if(n===1)return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'v3',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'viewImage',sha256:sha})}}]}}]})};
   return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);
  }});
  const worker=workerFor(await host.profile());
  const task={...scriptTask,artifact:{content:{files:[{path:'/tmp/big.png',sha256:sha,bytes:100,width:200,height:200}]}}};
  await host.runTask(task,{worker,callTool:async()=>({perception:'direct-image',imageUrl})});
  assert.equal(bodies.length,2);
  const first=JSON.stringify(bodies[0]).length,second=JSON.stringify(bodies[1]).length;
  assert.ok(second<first+10000,`second=${second} first=${first}`);
 }finally{await rm(dir,{recursive:true});}
});

test('tool text containing a data: URL is sanitized before sending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-or-view-sanitize-'));
 try{
  const secretsPath=await secrets(dir);
  const bodies=[];let n=0;
  const host=new OpenRouterHost({cwd:dir,secretsPath,fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);bodies.push(body);n++;
   if(n===1)return {ok:true,status:200,headers:{get:()=>null},json:async()=>({model:DEFAULT_OPENROUTER_MODEL,choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:'',tool_calls:[{id:'r1',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'readAsset',sha256:'f'.repeat(64)})}}]}}]})};
   return okResponse(DEFAULT_OPENROUTER_MODEL,scriptEvent);
  }});
  const worker=workerFor(await host.profile());
  await host.runTask(scriptTask,{worker,callTool:async()=>({note:'prefix data:image/png;base64,QUJDRA== suffix'})});
  const tool=bodies[1].messages.find(m=>m.role==='tool');
  assert.ok(tool);
  assert.ok(!tool.content.includes('data:image/png;base64'));
  assert.match(tool.content,/\[binary data omitted: image\/png\]/);
 }finally{await rm(dir,{recursive:true});}
});
