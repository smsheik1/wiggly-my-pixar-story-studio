import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../runtime/contracts.mjs';
import {CodexHost,driveCrew,reconcileDispatch} from '../runtime/codex-host.mjs';
import {openWorkflow} from '../runtime/workflow.mjs';
import {inputs,event,script} from './helpers.mjs';

// REAL error shape recorded by codex-cli 0.162.0 app-server for the r4 usage-limit turn.
const nativeUsageLimitError={message:'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:34 PM.',codexErrorInfo:'usageLimitExceeded',additionalDetails:null,misalignment:null};
const objectKeyedError={message:'You’ve hit your usage limit. Try again at 10:15 PM.',codexErrorInfo:{usageLimitExceeded:{limit:'plan'}},additionalDetails:null};

function hostFixture({error=nativeUsageLimitError}={}){
 const requests=[],child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
 let id=0;const persisted=new Set();
 const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');
 child.stdin=new Writable({write(chunk,_encoding,callback){for(const line of chunk.toString().trim().split('\n')){if(!line)continue;const request=JSON.parse(line);requests.push(request);
  if(request.method==='initialized')continue;
  if(request.method==='initialize'){emit({id:request.id,result:{platformFamily:'unix'}});continue;}
  if(request.method==='thread/start'){const workerId=`isolated-${++id}`;persisted.add(workerId);emit({id:request.id,result:{model:request.params.model,thread:{id:workerId}}});continue;}
  if(request.method==='thread/resume'){if(!persisted.has(request.params.threadId)){emit({id:request.id,error:{message:'no rollout found'}});continue;}emit({id:request.id,result:{model:request.params.model,thread:{id:request.params.threadId}}});continue;}
  if(request.method==='turn/start'){
   if(request.params.input[0].text.startsWith('Initialization only:')){const turnId=`init-turn-${request.params.threadId}`;emit({id:request.id,result:{turn:{id:turnId}}});emit({method:'item/completed',params:{threadId:request.params.threadId,turnId,item:{type:'agentMessage',text:'READY'}}});emit({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:turnId,status:'completed'}}});continue;}
   emit({id:request.id,result:{turn:{id:'turn-isolated'}}});
   emit({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn-isolated',status:'failed',error}}});
  }
 }callback();}});
 return {child,requests,spawnProcess:()=>child};
}

async function driveSetup(mock){
 const dir=await mkdtemp(join(tmpdir(),'memoir-usage-limit-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const host=new CodexHost({cwd:dir,spawnProcess:mock.spawnProcess});host.profile=async()=>'isolated-host-profile';
 await host.initialize();const crew=await host.startCrew();
 const init=await workflow.init('run',inputs,{workflowRevision:2});await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
 const task=(await workflow.status('run')).pending,path=join(dir,'dispatch',task.taskId+'.json');
 return {dir,workflow,host,task,path,options:{maxTasks:1,receiptDirectory:join(dir,'dispatch')}};
}

test('usage-limit defers without consuming an attempt and retries without --repair-invalid',async()=>{
 const mock=hostFixture(),{dir,workflow,host,path,options}=await driveSetup(mock);
 try{
  await assert.rejects(driveCrew(workflow,'run',host,options),/Codex usage limit reached; retry after 9:34 PM/);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'deferred');
  assert.equal(receipt.reason,'usage-limit');
  assert.equal(receipt.retryAfter,'9:34 PM');
  assert.equal(receipt.attempt,1);
  // No --repair-invalid needed: the next run retries the same task, not a repair.
  await assert.rejects(driveCrew(workflow,'run',host,options),/Codex usage limit reached; retry after 9:34 PM/);
  const second=JSON.parse(await readFile(path));
  assert.equal(second.status,'deferred');
  assert.equal(second.attempt,1);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});

test('deferred retry uses normal framing without repairFeedback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-usage-framing-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const seen=[];
 const usageError=Object.assign(new Error('Codex usage limit reached; retry after 9:34 PM. No model/provider fallback was submitted.'),{safeRetryWithoutOutput:true,usageLimitExceeded:true,retryAfter:'9:34 PM',savedTools:[]});
 const host={runTask:async(task,{worker})=>{seen.push(task);if(seen.length===1)throw usageError;return {taskId:task.taskId,actor:'agent',workerId:worker.workerId,action:'artifact',content:script};}};
 const crew={workers:Object.entries((await import('../runtime/crew.mjs')).crewRoles).map(([role,{name}])=>({workerId:`isolated-${role}`,name,role,modelVersion:'isolated-host',capabilityVersion:'isolated-tools',execution:'host'}))};
 const options={maxTasks:1,receiptDirectory:join(dir,'dispatch')};
 try{
  const init=await workflow.init('run',inputs,{workflowRevision:2});await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  await assert.rejects(driveCrew(workflow,'run',host,options),/usage limit reached/i);
  const receipt=JSON.parse(await readFile(join(options.receiptDirectory,(await workflow.status('run')).pending.taskId+'.json')));
  assert.equal(receipt.status,'deferred');
  assert.equal(receipt.attempt,1);
  const result=await driveCrew(workflow,'run',host,options);
  assert.equal(result.completed,1);
  assert.equal(seen.length,2);
  assert.equal(seen[1].repairFeedback,undefined);
  assert.doesNotMatch(JSON.stringify(seen[1]),/repair this validation error/i);
  const done=JSON.parse(await readFile(join(options.receiptDirectory,seen[1].taskId+'.json')));
  assert.equal(done.status,'completed');
  assert.equal(done.attempt,1);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('repeated usage limits never exhaust the finished-worker attempts',async()=>{
 const mock=hostFixture(),{dir,workflow,host,path,options}=await driveSetup(mock);
 try{
  await host.initialize().catch(()=>{});
  for(let i=0;i<5;i++)await assert.rejects(driveCrew(workflow,'run',host,options),/usage limit reached/i);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'deferred');
  assert.equal(receipt.attempt,1);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});

test('object-keyed codexErrorInfo usage-limit defers with its retry time',async()=>{
 const mock=hostFixture({error:objectKeyedError}),{dir,workflow,host,path,options}=await driveSetup(mock);
 try{
  await assert.rejects(driveCrew(workflow,'run',host,options),/retry after 10:15 PM/);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'deferred');
  assert.equal(receipt.reason,'usage-limit');
  assert.equal(receipt.attempt,1);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});

test('null-error failed turn stays uncertain and never records a rejection',async()=>{
 const mock=hostFixture({error:null}),{dir,workflow,host,path,options}=await driveSetup(mock);
 try{
  await assert.rejects(driveCrew(workflow,'run',host,options),/CODEX_TURN_FAILED|failed/);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'started');
  await assert.rejects(driveCrew(workflow,'run',host,options),/DISPATCH_UNCERTAIN/);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});

test('live path persists finished tool calls in the deferred receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-usage-tools-'));
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin={end(){}};child.kill=()=>{};
 const host=new CodexHost({cwd:dir,spawnProcess:()=>child});
 const worker={workerId:'thread-1',name:'Eli',role:'film-editor'};
 let captured=null;
 host.active={threadId:'thread-1',worker,callTool:async()=>({perception:'direct-image'}),resolve:()=>{},reject:error=>{captured=error;},output:'',buffer:[],pendingTools:0,finishedTools:[]};
 host.active.turnId='turn-1';
 host.send=()=>{};
 await host.toolCall({params:{threadId:'thread-1',turnId:'turn-1',tool:'wiggly_tool',arguments:{name:'viewImage',sha256:'a'.repeat(64),referenceSha256:null}}});
 assert.equal(host.active.finishedTools.length,1);
 host.message({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'failed',error:nativeUsageLimitError}}});
 try{
  assert.ok(captured);
  assert.equal(captured.usageLimitExceeded,true);
  assert.equal(captured.retryAfter,'9:34 PM');
  assert.equal(captured.savedTools.length,1);
 }finally{host.close();await rm(dir,{recursive:true});}
});

test('reconciled usage-limit defers and retries with the same attempt and normal framing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-usage-reconcile-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const worker={workerId:'native-worker',name:'Eli',role:'film-editor',modelVersion:'gpt-5.6-sol',capabilityVersion:'old',execution:'host'};
 const packet={task:{taskId:'saved-task',worker}};
 const userMessage={type:'userMessage',content:[{type:'text',text:JSON.stringify(packet)}]};
 const turn={id:'native-turn',status:'failed',error:nativeUsageLimitError,items:[userMessage,{type:'dynamicToolCall',status:'completed'}]};
 const reader={call:async()=>({thread:{id:worker.workerId,turns:[turn]}})};
 const receipt={status:'started',taskId:'saved-task',worker,workerDigest:digest(worker),attempt:2},path=join(dir,'saved-task.json');
 try{
  await writeFile(path,JSON.stringify(receipt));
  const result=await reconcileDispatch({taskId:'saved-task',crewWorker:worker},reader,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'});
  assert.equal(result.status,'deferred');
  assert.equal(result.reason,'usage-limit');
  assert.equal(result.retryAfter,'9:34 PM');
  assert.equal(result.attempt,2);
  assert.equal(result.event.savedTools.length,1);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('non-usage-limit clean failure stays rejected and needs --repair-invalid',async()=>{
 const failing={message:'ISOLATED provider unavailable',code:'providerError'};
 const mock=hostFixture({error:failing});
 const setup=await driveSetup(mock);
 try{
  await assert.rejects(driveCrew(setup.workflow,'run',setup.host,setup.options),/TURN_FAILED/);
  const receipt=JSON.parse(await readFile(setup.path));
  assert.equal(receipt.status,'rejected');
  assert.equal(receipt.reason,undefined);
  await assert.rejects(driveCrew(setup.workflow,'run',setup.host,setup.options),/RESULT_REJECTED/);
 }finally{setup.host.close();setup.workflow.close();await rm(setup.dir,{recursive:true});}
});
