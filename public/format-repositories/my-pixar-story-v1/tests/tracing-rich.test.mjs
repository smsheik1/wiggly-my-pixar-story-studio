// P15 richer tracing: every field a run trace must carry, redaction, truncation, send failures,
// journal + trace-export, and dept-eval --trace. Fake LangSmith client and fake fetchers only:
// no network, no child processes, never a codex app-server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTracer,sanitize,bound,_resetWarnedForTests} from '../runtime/tracing.mjs';
import {OpenRouterHost} from '../runtime/openrouter-host.mjs';
import {exportTraceMarkdown,traceExport} from '../runtime/trace-export.mjs';
import {tracedCase} from '../evaluation/dept-evals.mjs';

const MUSE='meta/muse-spark-1.3-contributor';
const OR_KEY='sk-or-v1-ISOLATEDKEY0123456789';
const LS_KEY='lsv2_pt_ISOLATEDLANGSMITH0123';
const OTHER='zz-other-secret-value-777';
const SHA='b'.repeat(64);
const PNG='data:image/png;base64,'+Buffer.from('fake-png-bytes-for-trace').toString('base64');

async function setup(){
 const dir=await mkdtemp(join(tmpdir(),'p15-trace-'));
 const secretsPath=join(dir,'secrets.env');
 await writeFile(secretsPath,`OPENROUTER_API_KEY=${OR_KEY}\nLANGSMITH_API_KEY=${LS_KEY}\nCARTESIA_API_KEY=${OTHER}\n`);
 return {dir,secretsPath};
}
const usage=(p,c,r,cost)=>({prompt_tokens:p,completion_tokens:c,total_tokens:p+c,cost,completion_tokens_details:{reasoning_tokens:r},prompt_tokens_details:{cached_tokens:5}});
const reply=(message,u,finish='stop')=>({ok:true,status:200,headers:{get:()=>null},json:async()=>({id:'gen-test',model:MUSE,provider:'Meta',usage:u,choices:[{finish_reason:finish,message}]})});
const fail=(status,text)=>({ok:false,status,headers:{get:()=>null},text:async()=>text});
const toolCall={role:'assistant',content:'looking',tool_calls:[{id:'c1',type:'function',function:{name:'wiggly_tool',arguments:JSON.stringify({name:'viewImage',sha256:SHA,referenceSha256:null})}}]};
const task={step:'script',taskId:'p15-task',actor:'agent',gate:'author',workflowRevision:2,studioSha256:'s'.repeat(64),
 skill:{path:'crew/vera/SKILL.md',content:'Vera skill text',sha256:'1'.repeat(64)},
 craft:[{id:'house-style',content:'craft one',sha256:'2'.repeat(64)},{id:'identity',content:'craft two',sha256:'3'.repeat(64)}]};
const eventFor=worker=>({taskId:'p15-task',actor:'agent',workerId:worker.workerId,action:'artifact',content:{beats:[]}});
const final=worker=>({role:'assistant',content:JSON.stringify({eventJson:JSON.stringify(eventFor(worker))})});
async function hostAndWorker(dir,secretsPath,tracer,responses){
 const seen=[];
 const host=new OpenRouterHost({cwd:dir,secretsPath,model:MUSE,tracer,fetcher:async(url,init)=>{seen.push(JSON.parse(init.body));const next=responses.shift();if(typeof next==='function')return next();return next;}});
 const worker={workerId:'openrouter:visual-reviewer:t',name:'Vera',role:'visual-reviewer',modelVersion:MUSE,capabilityVersion:await host.profile(),backend:'openrouter'};
 return {host,worker,seen};
}
const callTool=async(name,{sha256})=>({perception:'direct-image',sha256,imageUrl:PNG});
const dump=v=>JSON.stringify(v);

test('agent turn records label, model, system, packet, prompt sections, llm tokens+cost, tool call, response and totals',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const fake={captured:[]};
  const tracer=await createTracer({secretsPath,runId:'rich',runDir:dir,client:fake});
  const responses=[reply(toolCall,usage(100,20,7,0.001),'tool_calls')];
  const {host,worker}=await hostAndWorker(dir,secretsPath,tracer,responses);
  responses.push(reply(final(worker),usage(150,30,11,0.002)));
  const event=await host.runTask(task,{worker,callTool});
  assert.equal(event.action,'artifact');
  await tracer.flush();
  const c=fake.captured;
  const turn=c.find(r=>r.phase==='crew-turn');
  assert.equal(turn.label,'Vera, visual-reviewer');assert.equal(turn.model,MUSE);assert.equal(turn.workerId,worker.workerId);
  const call=c.find(r=>r.phase==='agent-call');
  assert.equal(call.parentId,turn.id,'agent-call nests under the turn');
  assert.match(call.system,/You are Vera, the visual-reviewer/);
  assert.match(call.packet,/Vera skill text/);assert.equal(call.packetChars,call.packet.length);assert.match(call.packetSha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(call.promptSections.map(s=>[s.kind,s.id,s.sha256]),[['skill','crew/vera/SKILL.md','1'.repeat(64)],['craft','house-style','2'.repeat(64)],['craft','identity','3'.repeat(64)]]);
  const llms=c.filter(r=>r.phase==='llm');assert.equal(llms.length,2);
  for(const l of llms){assert.equal(l.parentId,call.id);assert.equal(l.run_type,'llm');assert.equal(l.metadata.ls_model_name,MUSE);}
  const llmEnds=c.filter(r=>r.phase==='llm-end');
  assert.deepEqual(llmEnds.map(e=>[e.inputTokens,e.outputTokens,e.reasoningTokens,e.costUsd]),[[100,20,7,0.001],[150,30,11,0.002]]);
  assert.equal(llmEnds[0].usage_metadata.input_tokens,100);assert.equal(llmEnds[0].usage_metadata.output_token_details.reasoning,7);
  const tool=c.find(r=>r.phase==='tool');assert.equal(tool.toolName,'viewImage');assert.equal(tool.args.sha256,SHA);assert.equal(tool.parentId,call.id);
  const toolEnd=c.find(r=>r.phase==='tool-end');assert.equal(toolEnd.outcome,'completed');assert.equal(toolEnd.output.sha256,SHA);
  const callEnd=c.find(r=>r.phase==='agent-call-end');assert.match(callEnd.output,/eventJson/);assert.equal(callEnd.event.action,'artifact');
  const turnEnd=c.find(r=>r.phase==='crew-turn-end');
  assert.equal(turnEnd.outcome,'completed');assert.equal(turnEnd.requests,2);assert.equal(turnEnd.inputTokens,250);assert.equal(turnEnd.outputTokens,50);assert.equal(turnEnd.reasoningTokens,18);
  assert.ok(Math.abs(turnEnd.costUsd-0.003)<1e-9);assert.ok(turnEnd.durationMs>=0);
  // Images only as digests, never base64/data URLs, in captured runs and the journal.
  const journal=await readFile(join(dir,'trace','trace.jsonl'),'utf8');
  for(const text of [dump(c),journal]){assert.ok(!text.includes('base64,'));assert.ok(!text.includes(Buffer.from('fake-png-bytes-for-trace').toString('base64')));}
  assert.ok(journal.includes(SHA));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('review verdict carries per-criterion checks with evidence',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:'rv',client:fake});
  tracer.review({decision:'rejected',artifactId:'a1',reviewer:{label:'Vera, visual-reviewer',model:MUSE},selection:null,checks:[{criterion:'anatomy',status:'fail',evidence:'Option 2: fused fingers on the right hand',repair:'regenerate option 2'},{criterion:'style',status:'pass',evidence:'stylized 3D'}]});
  const r=fake.captured.find(x=>x.phase==='review');
  assert.equal(r.decision,'rejected');assert.equal(r.checks.length,2);assert.equal(r.checks[0].criterion,'anatomy');assert.match(r.checks[0].evidence,/fused fingers/);assert.equal(r.reviewer.label,'Vera, visual-reviewer');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('errors: HTTP 500, 429 and an invalid event are recorded with reason codes and retries',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  for(const [status,code] of [[500,'OPENROUTER_REQUEST_FAILED'],[429,'OPENROUTER_RATE_LIMITED']]){
   const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:`e${status}`,client:fake});
   const {host,worker}=await hostAndWorker(dir,secretsPath,tracer,[fail(status,`upstream says no; key ${OR_KEY}`)]);
   await assert.rejects(host.runTask(task,{worker,callTool}));
   const llmEnd=fake.captured.find(r=>r.phase==='llm-end');assert.equal(llmEnd.status,status);assert.ok(llmEnd.errorText);
   const turnEnd=fake.captured.find(r=>r.phase==='crew-turn-end');assert.equal(turnEnd.outcome,'error');assert.equal(turnEnd.reasonCode,code);
   assert.ok(!dump(fake.captured).includes(OR_KEY),'provider key leaked from an error body');
  }
  const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:'inv',client:fake});
  const bad={role:'assistant',content:JSON.stringify({eventJson:'{"not":"an event"}'})};
  const {host,worker}=await hostAndWorker(dir,secretsPath,tracer,[reply(bad,usage(10,5,0,0.0001)),reply(bad,usage(12,5,0,0.0001))]);
  await assert.rejects(host.runTask(task,{worker,callTool}),/INVALID_WORKER_EVENT/);
  assert.equal(fake.captured.filter(r=>r.phase==='llm').length,2,'validation retry is its own llm run');
  const turnEnd=fake.captured.find(r=>r.phase==='crew-turn-end');assert.equal(turnEnd.reasonCode,'INVALID_WORKER_EVENT');assert.equal(turnEnd.validationRetries,1);
  const callEnd=fake.captured.find(r=>r.phase==='agent-call-end');assert.match(callEnd.finishedResult,/not/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a failing task is never re-run by the tracing wrapper',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const tracer=await createTracer({secretsPath,runId:'once',client:{captured:[]}});
  const {host,worker,seen}=await hostAndWorker(dir,secretsPath,tracer,[fail(500,'x'),fail(500,'x')]);
  await assert.rejects(host.runTask(task,{worker,callTool}));
  assert.equal(seen.length,1,'one paid request, not two');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('redaction: provider keys, secrets-file values, Bearer tokens and auth headers never appear; token counts stay readable',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:'red',runDir:dir,client:fake});
  const h=tracer.tool({toolName:'x',note:`uses ${OR_KEY} and ${OTHER}`,headers:{Authorization:`Bearer abc.def-123`},text:'Bearer qwerty123 then lsv2_sk_abcdef123 and sk-or-v1-zzzz9999',apiKey:'plain'});
  h.end({input_tokens:5,output_token_details:{reasoning:2},promptTokenCount:9});
  await tracer.flush();
  const all=dump(fake.captured)+await readFile(join(dir,'trace','trace.jsonl'),'utf8');
  for(const s of [OR_KEY,OTHER,LS_KEY,'abc.def-123','qwerty123','lsv2_sk_abcdef123','sk-or-v1-zzzz9999','plain'])assert.ok(!all.includes(s),`${s} leaked`);
  const end=fake.captured.find(r=>r.phase==='tool-end');assert.equal(end.input_tokens,5);assert.equal(end.output_token_details.reasoning,2);assert.equal(end.promptTokenCount,9);
  assert.equal(sanitize({accessToken:'q'}).accessToken,'[REDACTED]');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('truncation: huge strings get a marker with sha; the per-run byte cap keeps tokens and cost only',{timeout:15000},async()=>{
 const big='x'.repeat(300000);
 const cut=bound({note:big,packet:big});
 assert.match(cut.note,/…\[truncated 236000 chars, sha256 [0-9a-f]{12}\]$/);
 assert.match(cut.packet,/…\[truncated 100000 chars, sha256 [0-9a-f]{12}\]$/);
 assert.equal(bound({a:Array.from({length:250},(_,i)=>i)}).a.length,201);
 const {dir,secretsPath}=await setup();
 const prev=process.stderr.write;process.stderr.write=()=>true;
 try{
  _resetWarnedForTests();
  const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:'cap',client:fake,limits:{maxRunBytes:20000}});
  for(let i=0;i<3;i++)tracer.tool({toolName:'t',payload:'some words '.repeat(1400)}).end({outcome:'completed'});
  const l=tracer.llm({model:MUSE,inputs:{messages:'more words '.repeat(1400)}});l.end({inputTokens:10,outputTokens:2,costUsd:0.5,content:'reply words '.repeat(400)});
  const last=fake.captured.filter(r=>r.phase==='llm-end').at(-1);
  assert.equal(last.budgetExhausted,true);assert.equal(last.inputTokens,10);assert.equal(last.costUsd,0.5);assert.equal(last.content,undefined);
  assert.equal(fake.captured.filter(r=>r.phase==='tool').at(-1).payload,undefined);
 }finally{process.stderr.write=prev;_resetWarnedForTests();await rm(dir,{recursive:true,force:true});}
});

test('send failures never fail a run: throwing client and rejecting LangSmith fetch',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 const writes=[];const prev=process.stderr.write;process.stderr.write=s=>{writes.push(String(s));return true;};
 try{
  _resetWarnedForTests();
  const throwing={get captured(){return {push(){throw new Error('backend down');}};},set captured(_v){}};
  const t1=await createTracer({secretsPath,runId:'f1',client:throwing});
  const r1=await hostAndWorker(dir,secretsPath,t1,[]);r1.seen.length=0;
  const responses1=[reply(final(r1.worker),usage(1,1,0,0))];
  const h1=new OpenRouterHost({cwd:dir,secretsPath,model:MUSE,tracer:t1,fetcher:async()=>responses1.shift()});
  assert.equal((await h1.runTask(task,{worker:r1.worker,callTool})).action,'artifact');
  await t1.flush(1000);
  // Live path: the LangSmith fetch rejects; the run still completes and flush resolves in time.
  _resetWarnedForTests();
  const t2=await createTracer({secretsPath,runId:'f2',fetcher:async()=>{throw new Error('network down');}});
  assert.equal(t2.enabled,true);
  const responses2=[reply(final(r1.worker),usage(1,1,0,0))];
  const h2=new OpenRouterHost({cwd:dir,secretsPath,model:MUSE,tracer:t2,fetcher:async()=>responses2.shift()});
  assert.equal((await h2.runTask(task,{worker:r1.worker,callTool})).action,'artifact');
  const t0=Date.now();await t2.flush(1500);assert.ok(Date.now()-t0<3000);
  assert.ok(writes.filter(w=>/tracing disabled/.test(w)).length<=2);
 }finally{process.stderr.write=prev;_resetWarnedForTests();await rm(dir,{recursive:true,force:true});}
});

test('disabled modes: no key writes only the journal; WIGGLY_TRACING=off writes nothing',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'p15-off-'));
 try{
  const noKey=join(dir,'nokey.env');await writeFile(noKey,'OPENROUTER_API_KEY=whatever-123456\n');
  const t=await createTracer({secretsPath:noKey,runId:'nk',runDir:join(dir,'run')});
  assert.equal(t.enabled,false);assert.equal(t.journaling,true);
  t.turn({role:'script-writer'}).end({outcome:'completed'});await t.flush();
  assert.match(await readFile(join(dir,'run','trace','trace.jsonl'),'utf8'),/crew-turn:script-writer/);
  process.env.WIGGLY_TRACING='off';
  const off=await createTracer({secretsPath:noKey,runId:'off',runDir:join(dir,'run-off')});
  off.turn({role:'x'}).end({});await off.flush();
  assert.equal(off.enabled,false);assert.equal(existsSync(join(dir,'run-off')),false);
 }finally{delete process.env.WIGGLY_TRACING;await rm(dir,{recursive:true,force:true});}
});

test('paid job records Gemini token usage with an estimated cost',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const fake={captured:[]};const tracer=await createTracer({secretsPath,runId:'pj',client:fake});
  const {paidJobTimer}=await import('../runtime/tracing.mjs');const {geminiUsage}=await import('../runtime/gemini-review.mjs');
  const u=geminiUsage({usage:{total_input_tokens:1200,total_output_tokens:300,total_thought_tokens:90}});
  assert.deepEqual(u,{inputTokens:1200,outputTokens:300,reasoningTokens:90});
  assert.deepEqual(geminiUsage({usageMetadata:{promptTokenCount:7,candidatesTokenCount:3,thoughtsTokenCount:1}}),{inputTokens:7,outputTokens:3,reasoningTokens:1});
  paidJobTimer(tracer,{provider:'gemini',jobId:'t',estimatedCostUsd:0.02,actualCostUsd:0.02,actualCostSource:'estimate'}).ok({usage:u});
  const end=fake.captured.find(r=>r.phase==='paid-job-end');
  assert.equal(end.usage.inputTokens,1200);assert.equal(end.usage.reasoningTokens,90);assert.equal(end.actualCostSource,'estimate');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('trace-export writes per-step markdown: agent, prompt sections, response, tool calls, review, cost',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const tracer=await createTracer({secretsPath,runId:'exp',runDir:dir,rootName:'drive-codex',client:{captured:[]}});
  const responses=[reply(toolCall,usage(100,20,7,0.001),'tool_calls')];
  const {host,worker}=await hostAndWorker(dir,secretsPath,tracer,responses);
  responses.push(reply(final(worker),usage(150,30,11,0.002)));
  await host.runTask(task,{worker,callTool});
  const turn=tracer.turn({role:'text-reviewer',label:'Sage, text-reviewer',model:MUSE,step:'script',gate:'review',taskId:'t2'});
  tracer.within(turn,()=>tracer.review({decision:'approved',checks:[{criterion:'facts',status:'pass',evidence:'matches answers'}]}));
  turn.end({outcome:'completed',durationMs:5});
  await tracer.flush();
  const out=join(dir,'export.md');
  const {markdown}=await traceExport({run:dir,out});
  assert.equal(await readFile(out,'utf8'),markdown);
  assert.match(markdown,/## 1\. script \/ author — Vera, visual-reviewer \(meta\/muse-spark-1\.3-contributor\)/);
  assert.match(markdown,/## 2\. script \/ review — Sage, text-reviewer/);
  assert.match(markdown,/\| craft \| house-style \| 222222222222 \|/);
  assert.match(markdown,/You are Vera/);assert.match(markdown,/eventJson/);
  assert.match(markdown,/viewImage\(bbbbbbbbbbbb\) → completed/);
  assert.match(markdown,/in 250 \/ out 50 \/ reasoning 18; cost \$0\.0030 over 2 requests/);
  assert.match(markdown,/Review verdict: approved/);assert.match(markdown,/facts: pass — matches answers/);
  assert.match(markdown,/Commands: drive-codex/);
  await assert.rejects(traceExport({run:join(dir,'nope')}),/TRACE_NOT_FOUND/);
  assert.match(exportTraceMarkdown(''),/No agent turns/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('dept-eval --trace wraps a case in a traced turn with a journal and run info',{timeout:15000},async()=>{
 const {dir,secretsPath}=await setup();
 try{
  const fake={captured:[]};
  const {outcome,trace}=await tracedCase({id:'case-x'},'replay',{trace:true,traceSecretsPath:secretsPath,traceClient:fake,tracesDir:dir},async(tracer)=>{
   const responses=[reply(final({workerId:'openrouter:visual-reviewer:t'}),usage(9,3,1,0.0004))];
   const {host,worker}=await hostAndWorker(dir,secretsPath,tracer,responses);
   const turn=tracer.turn({role:worker.role,label:'Vera, visual-reviewer',model:MUSE,caseId:'case-x'});
   const ev=await tracer.within(turn,()=>host.runTask(task,{worker,callTool}));
   turn.end({outcome:'completed',...turn._childTotals});
   return {event:ev};
  });
  assert.equal(outcome.event.action,'artifact');
  assert.match(trace.runId,/^dept-eval-case-x-/);assert.ok(existsSync(trace.journal));
  const kinds=new Set(fake.captured.map(r=>r.phase));
  for(const k of ['root','crew-turn','agent-call','llm','llm-end','crew-turn-end'])assert.ok(kinds.has(k),k);
  assert.ok(dump(fake.captured).includes('mode:replay'));
  const off=await tracedCase({id:'y'},'replay',{trace:false},async(t)=>t);
  assert.equal(off.outcome,null);assert.equal(off.trace,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
