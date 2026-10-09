import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../runtime/contracts.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexHost,driveCrew,reconcileDispatch} from '../runtime/codex-host.mjs';
import {openWorkflow} from '../runtime/workflow.mjs';
import {inputs,event} from './helpers.mjs';

function reconcileSetup(){
 const worker={workerId:'native-worker',name:'Eli',role:'film-editor',modelVersion:'gpt-5.6-sol',capabilityVersion:'old',execution:'host'},task={taskId:'saved-task',crewWorker:worker};
 const receipt={status:'started',taskId:task.taskId,worker,workerDigest:digest(worker),attempt:2};
 const packet={task:{taskId:task.taskId,worker}};
 const userMessage={type:'userMessage',content:[{type:'text',text:JSON.stringify(packet)}]};
 return {worker,task,receipt,userMessage};
}

test('failed turn with no output reconciles as safe to retry with a clear reason',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-reconcile-failed-'));
 const {task,receipt,userMessage}=reconcileSetup(),path=join(dir,task.taskId+'.json');
 const turn={id:'native-turn',status:'failed',error:{code:'usageLimitExceeded',message:'usageLimitExceeded: limit reached'},items:[userMessage]};
 const host={call:async()=>({thread:{id:receipt.worker.workerId,turns:[turn]}})};
 try{
  await writeFile(path,JSON.stringify(receipt));
  const result=await reconcileDispatch(task,host,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'});
  assert.equal(result.status,'rejected');
  assert.match(result.error,/turn failed before producing output/);
  assert.match(result.error,/usageLimitExceeded/);
  assert.equal(result.reconciliation.outcome,'confirmed-failed');
  assert.deepEqual(JSON.parse(await readFile(path+'.failed-2.json')),receipt);
  assert.deepEqual(JSON.parse(await readFile(result.reconciliation.evidencePath)),turn);
 }finally{await rm(dir,{recursive:true});}
});

test('failed turn with a final agent message stays refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-reconcile-failed-output-'));
 const {task,receipt,userMessage}=reconcileSetup(),path=join(dir,task.taskId+'.json');
 const turn={id:'native-turn',status:'failed',error:{code:'usageLimitExceeded',message:'usageLimitExceeded: limit reached'},items:[userMessage,{type:'agentMessage',text:'finished'}]};
 const host={call:async()=>({thread:{id:receipt.worker.workerId,turns:[turn]}})};
 try{
  await writeFile(path,JSON.stringify(receipt));
  await assert.rejects(reconcileDispatch(task,host,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'}),/UNCONFIRMED/);
  assert.deepEqual(JSON.parse(await readFile(path)),receipt);
 }finally{await rm(dir,{recursive:true});}
});

test('failed turn with an in-flight tool call stays refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-reconcile-failed-tool-'));
 const {task,receipt,userMessage}=reconcileSetup(),path=join(dir,task.taskId+'.json');
 const turn={id:'native-turn',status:'failed',error:{code:'usageLimitExceeded',message:'usageLimitExceeded: limit reached'},items:[userMessage,{type:'dynamicToolCall',status:'inProgress'}]};
 const host={call:async()=>({thread:{id:receipt.worker.workerId,turns:[turn]}})};
 try{
  await writeFile(path,JSON.stringify(receipt));
  await assert.rejects(reconcileDispatch(task,host,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'}),/UNCONFIRMED/);
  assert.deepEqual(JSON.parse(await readFile(path)),receipt);
 }finally{await rm(dir,{recursive:true});}
});

function usageLimitFixture({retryAfter='2026-10-09T01:00:00Z',error={code:'usageLimitExceeded',message:'usageLimitExceeded: limit reached',retryAfter}}={}){
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
   // Usage-limit failure before any agent message or tool call.
   emit({method:'turn/completed',params:{threadId:request.params.threadId,turn:{id:'turn-isolated',status:'failed',error}}});
  }
 }callback();}});
 return {child,requests,spawnProcess:()=>child};
}

test('host observing a failed turn records it in the receipt with the usage-limit retry-after',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-failed-host-drive-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const mock=usageLimitFixture({retryAfter:'2026-10-09T01:00:00Z'}),host=new CodexHost({cwd:dir,spawnProcess:mock.spawnProcess});host.profile=async()=>'isolated-host-profile';
 const options={maxTasks:1,receiptDirectory:join(dir,'dispatch')};
 try{
  await host.initialize();const crew=await host.startCrew();
  const init=await workflow.init('run',inputs,{workflowRevision:2});await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  const task=(await workflow.status('run')).pending,path=join(options.receiptDirectory,task.taskId+'.json');
  await assert.rejects(driveCrew(workflow,'run',host,options),/usage limit reached/i);
  const receipt=JSON.parse(await readFile(path));
  assert.notEqual(receipt.status,'started');
  assert.equal(receipt.status,'rejected');
  assert.match(receipt.error,/retry after 2026-10-09T01:00:00Z/);
  // No manual reconcile needed: the next run reports the recorded rejection, never uncertainty.
  await assert.rejects(driveCrew(workflow,'run',host,options),/RESULT_REJECTED/);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});

// Shape recorded by codex-cli 0.162.0 app-server for the real r4 usage-limit turn.
const nativeUsageLimitError={message:'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 9:34 PM.',codexErrorInfo:'usageLimitExceeded',additionalDetails:null,misalignment:null};

test('native usage-limit failed turn with a finished tool call reconciles with its retry time',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-reconcile-native-'));
 const {task,receipt,userMessage}=reconcileSetup(),path=join(dir,task.taskId+'.json');
 const turn={id:'native-turn',status:'failed',error:nativeUsageLimitError,items:[userMessage,{type:'reasoning'},{type:'dynamicToolCall',status:'completed'},{type:'reasoning'}]};
 const host={call:async()=>({thread:{id:receipt.worker.workerId,turns:[turn]}})};
 try{
  await writeFile(path,JSON.stringify(receipt));
  const result=await reconcileDispatch(task,host,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'});
  assert.equal(result.reconciliation.outcome,'confirmed-failed');
  assert.match(result.error,/turn failed before producing output: usageLimitExceeded: .*try again at 9:34 PM\. Continue/);
  assert.equal(result.event.savedTools.length,1);
 }finally{await rm(dir,{recursive:true});}
});

test('host observing the native usage-limit shape surfaces its retry time',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-failed-host-native-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const mock=usageLimitFixture({error:nativeUsageLimitError}),host=new CodexHost({cwd:dir,spawnProcess:mock.spawnProcess});host.profile=async()=>'isolated-host-profile';
 const options={maxTasks:1,receiptDirectory:join(dir,'dispatch')};
 try{
  await host.initialize();const crew=await host.startCrew();
  const init=await workflow.init('run',inputs,{workflowRevision:2});await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  const task=(await workflow.status('run')).pending,path=join(options.receiptDirectory,task.taskId+'.json');
  await assert.rejects(driveCrew(workflow,'run',host,options),/Codex usage limit reached; retry after 9:34 PM\./);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'rejected');
  assert.match(receipt.error,/retry after 9:34 PM\./);
 }finally{host.close();workflow.close();await rm(dir,{recursive:true});}
});
