import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../runtime/contracts.mjs';
import {driveCrew,reconcileDispatch,reconcileNotDispatched} from '../runtime/codex-host.mjs';
import {openWorkflow,taskFor} from '../runtime/workflow.mjs';
import {inputs,event,script} from './helpers.mjs';
import {crewRoles} from '../runtime/crew.mjs';

const crewWith=capabilityVersion=>({workers:Object.entries(crewRoles).map(([role,{name}])=>({workerId:`isolated-${role}`,name,role,modelVersion:'isolated-host',capabilityVersion,execution:'host'}))});
const PROFILE_ERROR='CODEX_PROFILE_CHANGED: host/tool version differs from the bound crew. Stop for explicit reconfiguration/qualification.';

test('driveCrew preflights capability before writing a started receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-preflight-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const crew=crewWith('old-profile');let runCalls=0;
 const host={preflight:async()=>{throw new Error(PROFILE_ERROR);},runTask:async(task,{worker})=>{runCalls++;return {taskId:task.taskId,actor:'agent',workerId:worker.workerId,action:'artifact',content:script};}};
 const receiptDir=join(dir,'dispatch');
 try{
  const init=await workflow.init('run',inputs,{workflowRevision:2});
  await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  const task=(await workflow.status('run')).pending,path=join(receiptDir,task.taskId+'.json');
  await assert.rejects(driveCrew(workflow,'run',host,{maxTasks:1,receiptDirectory:receiptDir}),/CODEX_PROFILE_CHANGED/);
  assert.equal(runCalls,0);
  await assert.rejects(readFile(path),/ENOENT/);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('driveCrew preflights worker identity before writing a started receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-worker-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const crew=crewWith('isolated-tools');let runCalls=0;
 const host={preflight:async()=>{throw new Error('CODEX_WORKER_CHANGED');},runTask:async(task,{worker})=>{runCalls++;return {taskId:task.taskId,actor:'agent',workerId:worker.workerId,action:'artifact',content:script};}};
 const receiptDir=join(dir,'dispatch');
 try{
  const init=await workflow.init('run',inputs,{workflowRevision:2});
  await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  const task=(await workflow.status('run')).pending,path=join(receiptDir,task.taskId+'.json');
  await assert.rejects(driveCrew(workflow,'run',host,{maxTasks:1,receiptDirectory:receiptDir}),/CODEX_WORKER_CHANGED/);
  assert.equal(runCalls,0);
  await assert.rejects(readFile(path),/ENOENT/);
  // An existing receipt is left byte-identical when preflight refuses.
  const prior={status:'rejected',taskId:task.taskId,worker:task.crewWorker,workerDigest:digest(task.crewWorker),attempt:1,error:'ISOLATED known rejection',event:{}};
  await writeFile(path,JSON.stringify(prior));
  await assert.rejects(driveCrew(workflow,'run',host,{maxTasks:1,receiptDirectory:receiptDir,repairInvalid:true}),/CODEX_WORKER_CHANGED/);
  assert.equal(runCalls,0);
  assert.deepEqual(JSON.parse(await readFile(path)),prior);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('stranded started receipt reconciles as not-dispatched and redispatches at the same attempt after refresh',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-recover-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const receiptDir=join(dir,'dispatch');
 try{
  const init=await workflow.init('run',inputs,{workflowRevision:2});
  await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew:crewWith('old')}));
  const task=(await workflow.status('run')).pending,path=join(receiptDir,task.taskId+'.json');
  const {mkdir}=await import('node:fs/promises');await mkdir(receiptDir,{recursive:true});
  // Stranded by a profile change: started receipt, old capability, no turn id.
  const stranded={status:'started',taskId:task.taskId,worker:task.crewWorker,workerDigest:digest(task.crewWorker),attempt:1};
  await writeFile(path,JSON.stringify(stranded));
  const ready={id:'init-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'Initialization only: acknowledge your assigned role by replying READY.'}]}]};
  const other={id:'other-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:JSON.stringify({task:{taskId:'unrelated-task',worker:{workerId:'unrelated'}}})}]}]};
  const reader={call:async(method,args)=>{assert.equal(method,'thread/read');assert.equal(args.threadId,task.crewWorker.workerId);return {thread:{id:task.crewWorker.workerId,turns:[ready,other]}};}};
  const result=await reconcileNotDispatched(task,reader,{receiptDirectory:receiptDir,message:'Actual human: never dispatched, safe to retry'});
  assert.equal(result.status,'not-dispatched');
  assert.equal(result.reconciliation.outcome,'confirmed-not-dispatched');
  assert.equal(result.attempt,1);
  assert.deepEqual(JSON.parse(await readFile(path+'.not-dispatched-1.json')),stranded);
  assert.deepEqual(JSON.parse(await readFile(result.reconciliation.evidencePath)).id,task.crewWorker.workerId);
  // crew-refresh guard only refuses status started, so it now proceeds.
  assert.notEqual(JSON.parse(await readFile(path)).status,'started');
  // Simulated crew refresh changing capabilityVersion only.
  await workflow.respond('run',event((await workflow.status('run')).project,'configure-crew',{actor:'human',message:'ISOLATED explicit host refresh',crew:crewWith('new')}));
  const fresh=(await workflow.status('run')).pending;
  assert.equal(fresh.taskId,task.taskId);
  let runCalls=0;
  const driver={preflight:async()=>{},runTask:async(t,{worker})=>{runCalls++;assert.equal(worker.capabilityVersion,'new');return {taskId:t.taskId,actor:'agent',workerId:worker.workerId,action:'artifact',content:script};}};
  const done=await driveCrew(workflow,'run',driver,{maxTasks:1,receiptDirectory:receiptDir});
  assert.equal(done.completed,1);assert.equal(runCalls,1);
  const receipt=JSON.parse(await readFile(path));
  assert.equal(receipt.status,'completed');assert.equal(receipt.attempt,1);
  assert.deepEqual(JSON.parse(await readFile(path+'.not-dispatched-1.json')),stranded);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('reconcileNotDispatched refuses without direction or a clean started receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-deny-'));
 const worker={workerId:'native-worker',name:'Max',role:'generation-planner',modelVersion:'gpt-5.6-sol',capabilityVersion:'old',execution:'host'},task={taskId:'saved-task',crewWorker:worker};
 const path=join(dir,task.taskId+'.json'),reader={call:async()=>({thread:{id:worker.workerId,turns:[{id:'init-turn',status:'completed',items:[]}]}})};
 try{
  const clean={status:'started',taskId:task.taskId,worker,workerDigest:digest(worker),attempt:1};
  const cases=[
   ['missing message',{...clean},'',task],
   ['not started',{...clean,status:'rejected',error:'x',event:{}},'Actual direction',task],
   ['digest mismatch',{...clean},'Actual direction',{taskId:task.taskId,crewWorker:{...worker,modelVersion:'other'}}],
   ['turn reference',{...clean,turnId:'native-turn'},'Actual direction',task],
  ];
  for(const [name,receipt,message,forTask] of cases){
   await writeFile(path,JSON.stringify(receipt));
   const before=await readFile(path,'utf8');
   await assert.rejects(reconcileNotDispatched(forTask,reader,{receiptDirectory:dir,message}),/DISPATCH_RECONCILIATION_DENIED/,name);
   assert.equal(await readFile(path,'utf8'),before,name);
  }
  await rm(path,{force:true});
  await assert.rejects(reconcileNotDispatched(task,reader,{receiptDirectory:dir,message:'Actual direction'}),/DISPATCH_RECONCILIATION_DENIED/);
  assert.deepEqual(await readdir(dir),[]);
 }finally{await rm(dir,{recursive:true});}
});

test('reconcileNotDispatched refuses when any native turn may belong to this task',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-proof-'));
 const worker={workerId:'native-worker',name:'Max',role:'generation-planner',modelVersion:'gpt-5.6-sol',capabilityVersion:'old',execution:'host'},task={taskId:'saved-task',crewWorker:worker};
 const path=join(dir,task.taskId+'.json'),receipt={status:'started',taskId:task.taskId,worker,workerDigest:digest(worker),attempt:1};
 const packet=status=>({id:'native-turn',status,items:[{type:'userMessage',content:[{type:'text',text:JSON.stringify({task:{taskId:task.taskId,worker:{workerId:worker.workerId}}})}]}]});
 const unrelated=status=>({id:'other-turn',status,items:[{type:'userMessage',content:[{type:'text',text:JSON.stringify({task:{taskId:'other-task',worker:{workerId:'other'}}})}]}]});
 try{
  const cases=[
   ['packet in interrupted turn',{thread:{id:worker.workerId,turns:[packet('interrupted')]}}],
   ['packet in failed turn',{thread:{id:worker.workerId,turns:[packet('failed')]}}],
   ['packet in completed turn',{thread:{id:worker.workerId,turns:[packet('completed')]}}],
   ['turn in progress',{thread:{id:worker.workerId,turns:[{id:'running-turn',status:'inProgress',items:[unrelated('inProgress')] }]}}],
   ['taskId in non-JSON text',{thread:{id:worker.workerId,turns:[{id:'note-turn',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:`notes about saved-task progress`}]}]}]}}],
   ['thread id mismatch',{thread:{id:'other-thread',turns:[]}}],
   ['turns missing',{thread:{id:worker.workerId}}],
   ['turns empty',{thread:{id:worker.workerId,turns:[]}}],
  ];
  for(const [name,result] of cases){
   await writeFile(path,JSON.stringify(receipt));
   const before=await readFile(path,'utf8');
   await assert.rejects(reconcileNotDispatched(task,{call:async()=>result},{receiptDirectory:dir,message:'Actual direction'}),/DISPATCH_RECONCILIATION_UNCONFIRMED/,name);
   assert.equal(await readFile(path,'utf8'),before,name);
  }
  await writeFile(path,JSON.stringify(receipt));
  const before=await readFile(path,'utf8');
  await assert.rejects(reconcileNotDispatched(task,{call:async()=>{throw new Error('ISOLATED thread/read down');}},{receiptDirectory:dir,message:'Actual direction'}),/DISPATCH_RECONCILIATION_UNCONFIRMED/);
  assert.equal(await readFile(path,'utf8'),before);
 }finally{await rm(dir,{recursive:true});}
});

test('existing turn reconcile path still archives interrupted turns',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-deadlock-compat-'));
 const worker={workerId:'native-worker',name:'Eli',role:'film-editor',modelVersion:'gpt-5.6-sol',capabilityVersion:'old',execution:'host'},task={taskId:'saved-task',crewWorker:worker};
 const receipt={status:'started',taskId:task.taskId,worker,workerDigest:digest(worker),attempt:2},path=join(dir,task.taskId+'.json');
 const turn={id:'native-turn',status:'interrupted',items:[{type:'userMessage',content:[{type:'text',text:JSON.stringify({task:{taskId:task.taskId,worker}})}]},{type:'dynamicToolCall',status:'failed'}]};
 const host={call:async()=>({thread:{id:worker.workerId,turns:[turn]}})};
 try{
  await writeFile(path,JSON.stringify(receipt));
  const result=await reconcileDispatch(task,host,{receiptDirectory:dir,turnId:turn.id,message:'Actual direction'});
  assert.equal(result.status,'rejected');assert.equal(result.attempt,2);
  assert.deepEqual(JSON.parse(await readFile(path+'.interrupted-2.json')),receipt);
 }finally{await rm(dir,{recursive:true});}
});
