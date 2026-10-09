import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createTracer,sanitize,TRACING_PROJECT} from '../runtime/tracing.mjs';
import {driveCrew} from '../runtime/codex-host.mjs';
import {openWorkflow} from '../runtime/workflow.mjs';
import {inputs,event,script} from './helpers.mjs';

const fakePngDataUrl='data:image/png;base64,'+Buffer.from('fake-image-bytes-123').toString('base64');
const fakeAudioBytes=Buffer.from('fake-audio-bytes-456');
const fakeSecret='sk-fake-secret-789';
const privatePhotoPath='/Users/shaz/wiggly-private-backups/photos/family-photo.png';

function secretsFile(extra=''){
 return (async()=>{
  const dir=await mkdtemp(join(tmpdir(),'memoir-tracing-'));
  const path=join(dir,'secrets.env');
  await writeFile(path,`LANGSMITH_API_KEY=ls-fake-key\nCARTESIA_API_KEY=${fakeSecret}\n${extra}`);
  return {dir,path};
 })();
}

test('tracing disabled without a key or with WIGGLY_TRACING=off',async()=>{
 const {dir,path}=await secretsFile();
 const empty=join(dir,'empty.env');await writeFile(empty,'CARTESIA_API_KEY=x\n');
 try{
  const noKey=await createTracer({secretsPath:empty,runId:'r1'});
  assert.equal(noKey.enabled,false);
  const missing=await createTracer({secretsPath:join(dir,'nope.env'),runId:'r1'});
  assert.equal(missing.enabled,false);
  process.env.WIGGLY_TRACING='off';
  const off=await createTracer({secretsPath:path,runId:'r1'});
  assert.equal(off.enabled,false);
 }finally{delete process.env.WIGGLY_TRACING;await rm(dir,{recursive:true});}
});

test('tree shape carries crew turn, tool, review and paid-job children with run-id tag',async()=>{
 const {dir,path}=await secretsFile();
 try{
  const fake={captured:[]};
  const tracer=await createTracer({secretsPath:path,runId:'run-123',client:fake});
  assert.equal(tracer.enabled,true);
  assert.equal(tracer.projectName,TRACING_PROJECT);
  const turn=tracer.turn({role:'film-editor',workerName:'Eli',model:'gpt-5.6-sol',taskId:'t1',step:'script',gate:'author',attempt:1});
  turn.end({outcome:'completed',durationMs:12});
  const tool=tracer.tool({toolName:'viewImage'});
  tool.end({outcome:'completed',durationMs:3});
  tracer.review({decision:'approved',artifactId:'a1'});
  tracer.paidJob({provider:'cartesia',estimatedCostUsd:0.05,actualCostUsd:null});
  const dumped=JSON.stringify(fake.captured);
  assert.match(dumped,/crew-turn:film-editor/);
  assert.match(dumped,/Eli/);
  assert.match(dumped,/gpt-5.6-sol/);
  assert.match(dumped,/tool:viewImage/);
  assert.match(dumped,/approved/);
  assert.match(dumped,/cartesia/);
  assert.match(dumped,/0\.05/);
  for(const run of fake.captured)assert.ok(run.tags.includes('run:run-123'));
  assert.equal(fake.captured[0].project_name,TRACING_PROJECT);
 }finally{await rm(dir,{recursive:true});}
});

test('sanitizer never leaks media bytes, secrets, or private paths',async()=>{
 const {dir,path}=await secretsFile();
 try{
  const fake={captured:[]};
  const tracer=await createTracer({secretsPath:path,runId:'leak-check',client:fake});
  const imageBytes=Buffer.from('fake-image-bytes-123');
  const expectedDigest=createHash('sha256').update(imageBytes).digest('hex');
  tracer.turn({role:'visual-reviewer',workerName:'Vera',model:'m',taskId:'t',step:'candidates',gate:'review',attempt:1,evidence:{imageUrl:fakePngDataUrl,photo:privatePhotoPath,audio:fakeAudioBytes,secret:fakeSecret,inline:{type:'image',data:imageBytes.toString('base64')}}});
  tracer.tool({toolName:'listenAudio',file:{path:privatePhotoPath},key:fakeSecret});
  const dumped=JSON.stringify(fake.captured);
  assert.ok(!dumped.includes('base64,'),'data URL leaked');
  assert.ok(!dumped.includes(imageBytes.toString('base64')),'raw base64 leaked');
  assert.ok(!dumped.includes(fakeSecret),'secret value leaked');
  assert.ok(!dumped.includes('/Users/shaz/wiggly-private-backups'),'private path leaked');
  assert.ok(!dumped.includes('fake-audio-bytes-456'),'audio bytes leaked');
  assert.ok(dumped.includes(expectedDigest),'digest missing');
  assert.ok(dumped.includes('family-photo.png'),'basename missing');
  // Direct sanitizer checks.
  assert.deepEqual(sanitize(fakePngDataUrl).sha256,expectedDigest);
  assert.equal(sanitize({apiKey:fakeSecret}).apiKey,'[REDACTED]');
  assert.equal(sanitize(privatePhotoPath),'family-photo.png');
 }finally{await rm(dir,{recursive:true});}
});

test('throwing tracing backend never breaks driveCrew',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-tracing-drive-')),workflow=openWorkflow(join(dir,'state.sqlite'));
 const crew={workers:Object.entries((await import('../runtime/crew.mjs')).crewRoles).map(([role,{name}])=>({workerId:`isolated-${role}`,name,role,modelVersion:'isolated-host',capabilityVersion:'isolated-tools',execution:'host'}))};
 const host={runTask:async(task,{worker})=>({taskId:task.taskId,actor:'agent',workerId:worker.workerId,action:'artifact',content:script})};
 const throwing={
  enabled:true,projectName:TRACING_PROJECT,runId:'throw',
  turn:()=>({end(){throw new Error('trace down');}}),
  tool:()=>{throw new Error('trace down');},
  review(){throw new Error('trace down');},
  paidJob(){throw new Error('trace down');},
  flush:async()=>{throw new Error('trace down');},
 };
 try{
  const init=await workflow.init('run',inputs,{workflowRevision:2});await workflow.respond('run',event(init.project,'configure-crew',{actor:'human',message:'ISOLATED',crew}));
  const result=await driveCrew(workflow,'run',host,{maxTasks:1,receiptDirectory:join(dir,'dispatch'),tracer:throwing});
  assert.equal(result.completed,1);
 }finally{workflow.close();await rm(dir,{recursive:true});}
});

test('live LangSmith path ends every run, keeps digests and scrubs any secrets-file value (fake fetch, no network)',async()=>{
 const {dir,path}=await secretsFile('OTHER_TOKEN=zz-unlisted-secret-999\n');
 const bodies=[];
 const fetcher=async(url,init={})=>{let body=init.body;if(body&&typeof body!=='string')body=await new Response(body).text();bodies.push(String(body??''));return new Response(JSON.stringify({batch_ingest_config:{use_multipart_endpoint:false}}),{status:200,headers:{'content-type':'application/json'}});};
 try{
  const tracer=await createTracer({secretsPath:path,runId:'live-check',fetcher});
  assert.equal(tracer.enabled,true);
  const sha='a'.repeat(64);
  const turn=tracer.turn({role:'visual-reviewer',taskId:'t1',note:'zz-unlisted-secret-999',key:fakeSecret,evidence:{imageUrl:fakePngDataUrl,sha256:sha}});
  turn.end({outcome:'completed',durationMs:1});
  await new Promise(resolve=>setTimeout(resolve,20));
  await tracer.flush(5000);
  const sent=bodies.join('\n');
  assert.ok(!sent.includes('zz-unlisted-secret-999'),'unlisted secrets-file value leaked');
  assert.ok(!sent.includes(fakeSecret),'secret value leaked');
  assert.ok(!sent.includes('base64,'),'data URL leaked');
  assert.ok(sent.includes(sha),'hex digest was wrongly omitted');
  const runs=sent.split('\n').filter(Boolean).flatMap(line=>{try{const batch=JSON.parse(line);return [...(batch.post??[]),...(batch.patch??[])];}catch{return [];}});
  const ended=new Set(runs.filter(run=>run.end_time).map(run=>run.name));
  assert.ok(ended.has('drive-codex'),'root run never ended');
  assert.ok(ended.has('crew-turn:visual-reviewer'),'child run never ended');
 }finally{await rm(dir,{recursive:true});}
});
