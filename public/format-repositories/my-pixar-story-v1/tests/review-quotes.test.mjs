import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {crewRoles,runCrewTask} from '../runtime/crew.mjs';
import {initialProject,taskFor,current} from '../runtime/workflow.mjs';
import {importMedia} from '../runtime/media.mjs';
import {digest} from '../runtime/contracts.mjs';
import {event,inputs,script,send,audioProject} from './helpers.mjs';

const crew={workers:Object.keys(crewRoles).map(role=>({workerId:`host-${role}`,name:crewRoles[role].name,role,modelVersion:'inherit-current-test-host',capabilityVersion:'isolated-tools-v1',execution:'host'}))};
const bind=p=>send(p,'configure-crew',{actor:'human',message:'ISOLATED bind actual test workers.',crew});
function sageTask(){
 let p=bind(initialProject('quotes',inputs,{workflowRevision:2}));
 p=send(p,'artifact',{workerId:'host-script-writer',content:script});
 const task=taskFor(p);
 assert.equal(task.crewWorker.role,'text-reviewer');
 return {p,task,worker:task.crewWorker};
}
const genuine=script.beats[0].narration.slice(0,24);
const reviewFor=(p,task,worker,quotes)=>event(p,'review',{workerId:worker.workerId,artifactId:current(p).id,artifactDigest:current(p).digest,review:{decision:'approved',perception:'direct-text',modelVersion:worker.modelVersion,capabilityVersion:worker.capabilityVersion,checks:task.criteria.map(criterion=>({criterion,status:'pass',evidence:'ISOLATED quote check',location:'whole',...(quotes===null?{}:{quotes})}))}});

test('fabricated quote is rejected with REVIEW_QUOTE_NOT_FOUND',async()=>{
 const {p,task,worker}=sageTask();
 await assert.rejects(runCrewTask(p,task,{runTask:async()=>reviewFor(p,task,worker,['This sentence was never written anywhere'])}),e=>e.knownFinished&&/REVIEW_QUOTE_NOT_FOUND/.test(e.message));
});

test('genuine quote from the artifact is accepted',async()=>{
 const {p,task,worker}=sageTask();
 const result=await runCrewTask(p,task,{runTask:async()=>reviewFor(p,task,worker,[genuine])});
 assert.equal(result.review.decision,'approved');
});

test('genuine quote from a transcript tool output is accepted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-quote-stt-'));
 try{
  const out=join(dir,'tone.wav'),source=join(dir,'sample.wav');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=400:duration=0.15',out]);
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=600:duration=10',source]);
  const file=await importMedia(out,dir),sample=await importMedia(source,dir);
  const p0=audioProject();p0.step='audition';p0.gate='review';
  current(p0,'voiceSample').content.files=[sample];
  const a=current(p0);a.content.files=[file];a.digest=digest(a.content);
  const q=current(p0,'audioReviewerQualification').content;
  p0.crew={workers:crew.workers.map(w=>w.role==='audio-reviewer'?{...w,workerId:q.workerId,modelVersion:q.modelVersion,capabilityVersion:q.capabilityVersion}:w)};
  const task=taskFor(p0);
  const heard='Zebra stripes yellow balloon transcript words here';
  const host={tools:{
   listenAudio:async()=>({perception:'direct-audio',seconds:file.durationSeconds}),
   transcribe:async()=>({transcript:heard,method:'ISOLATED STT'}),
   speakerSimilarity:async()=>({score:0.9,method:'ISOLATED embedding',calibrationNotes:'ISOLATED test'}),
  },runTask:async(_task,{worker,callTool})=>{
   for(const tool of ['listenAudio','measureAudio','transcribe','speakerSimilarity'])await callTool(tool,{sha256:file.sha256,referenceSha256:sample.sha256});
   return event(p0,'review',{workerId:worker.workerId,artifactId:a.id,artifactDigest:a.digest,review:{decision:'approved',perception:'direct-audio',modelVersion:worker.modelVersion,capabilityVersion:worker.capabilityVersion,coverage:{artifactSha256:file.sha256,audioFiles:[{sha256:file.sha256,seconds:file.durationSeconds}]},checks:task.criteria.map(criterion=>({criterion,status:'pass',evidence:'ISOLATED transcript quote',location:'whole fixture',quotes:[heard]})),measurements:{transcripts:[heard]}}});
  }};
  const result=await runCrewTask(p0,task,host);
  assert.equal(result.review.decision,'approved');
 }finally{await rm(dir,{recursive:true});}
});

test('missing quotes are rejected for pass/fail checks',async()=>{
 const {p,task,worker}=sageTask();
 await assert.rejects(runCrewTask(p,task,{runTask:async()=>reviewFor(p,task,worker,null)}),e=>e.knownFinished&&/REVIEW_QUOTE_MISSING/.test(e.message));
});

test('Vera and June reviews are unaffected by the quote rule',async()=>{
 let p=bind(initialProject('quotes-vera',inputs,{workflowRevision:2}));
 p=send(p,'artifact',{workerId:'host-script-writer',content:script});
 const task=taskFor(p);
 // Directly verify a Vera-style review object passes quote verification trivially.
 const {verifyReviewQuotes}=await import('../runtime/crew.mjs');
 verifyReviewQuotes({role:'visual-reviewer',task,review:{decision:'approved',checks:task.criteria.map(criterion=>({criterion,status:'pass'}))},outputs:new Map()});
 verifyReviewQuotes({role:'scene-reviewer',task,review:{decision:'rejected',checks:task.criteria.map(criterion=>({criterion,status:'fail'}))},outputs:new Map()});
 assert.ok(true);
});
