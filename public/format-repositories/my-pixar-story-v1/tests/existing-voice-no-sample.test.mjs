import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {initialProject,current,taskFor,revisionImpact,openWorkflow,crewReviewEligible} from '../runtime/workflow.mjs';
import {digest} from '../runtime/contracts.mjs';
import {voiceBasis,narrationLocked,assertAllowed,consentedVoiceIdentity} from '../runtime/gates.mjs';
import {requestDescriptor} from '../runtime/providers.mjs';
import {producerUpdate} from '../runtime/presentation.mjs';
import {prepareCrewTask,runCrewTask,crewRoles} from '../runtime/crew.mjs';
import {importMedia,sha} from '../runtime/media.mjs';
import {createCartesiaTranscriptionTool} from '../runtime/cartesia-stt.mjs';
import {inputs,script,send,event,approved,reviewed,file,produce,captureEvents,qualifyTestAudio,audioProject} from './helpers.mjs';

import { choice, lookup, draft, start, choose, verify, ready, audition, reviewEvent, passReview, humanApprove } from './helpers/existing-voice.mjs';
export { choice, lookup, draft, start, choose, verify, ready, audition, reviewEvent, passReview, humanApprove };

test('new clone requires a genuine sample; verified existing clone reaches audition with no recording, dummy artifact or generation job',()=>{
 const fresh=start();assert.equal(fresh.step,'voiceSample');assert.match(producerUpdate({project:fresh,pending:taskFor(fresh)}).message,/Record 20–30 seconds/);
 assert.throws(()=>send(fresh,'plan',{plan:{provider:'cartesia',operation:'clone',estimatedCostUsd:.05,parameters:{}}}),/not allowed/);
 let p=choose(fresh);assert.equal(producerUpdate({project:p,pending:taskFor(p)}).inputRequest,null);assert.match(producerUpdate({project:p,pending:taskFor(p)}).message,/No new recording/);
 p=verify(p);assert.equal(p.step,'audition');assert.equal(p.gate,'produce');assert.equal(current(p,'voiceSample'),undefined);assert.deepEqual(current(p,'clone').dependencies,[]);assert.equal(p.jobs.length,0);
 assert.deepEqual(voiceBasis(p),{kind:'existing-clone',language:'en',referenceSha256:null,voiceId:choice.voiceId});
 for(const operation of ['audition','narration']){const request=requestDescriptor(p,{provider:'cartesia',operation,estimatedCostUsd:.05,parameters:{}});assert.equal(request.language,'en');assert.equal(request.voice,choice.voiceId);assert.equal(request.generation_config.speed,1);assert.equal(request.transcripts.length,operation==='audition'?1:4);}
 assert.throws(()=>assertAllowed(p,'keyframe'),/NARRATION_LOCK_REQUIRED/);assert.equal(narrationLocked(p),false);
});

test('historical verified selection changes only through explicit human reuse and stays debug-paused with story locks preserved',()=>{
 let p=verify(choose(start(),{...choice,reuseWithoutSample:false}));assert.equal(p.step,'voiceSample');const bytes=JSON.stringify(current(p,'script'));
 p=send(p,'configure-debug',{actor:'human',message:'ISOLATED debug',debugEnabled:true});
 assert.throws(()=>send(p,'reuse-voice',{actor:'agent',message:'ISOLATED'}),/human/);
 const unverified=choose(start());assert.throws(()=>send(unverified,'reuse-voice',{actor:'human',message:'ISOLATED'}),/NOT_VERIFIED/);
 p=send(p,'reuse-voice',{actor:'human',message:'ISOLATED skip recording for my existing clone'});assert.equal(p.step,'audition');assert.equal(p.debug.paused,true);assert.equal(JSON.stringify(current(p,'script')),bytes);assert.equal(p.jobs.length,0);
 assert.throws(()=>send(p,'reuse-voice',{actor:'human',message:'ISOLATED'}),/EXISTING_VOICE_LOCKED/);
 assert.throws(()=>send(p,'plan',{plan:{provider:'cartesia',operation:'audition',estimatedCostUsd:.05,parameters:{}}}),/DEBUG_PAUSED/);
});

test('sample-free audio review requires real human identity recognition and cannot invent similarity or source evidence',()=>{
 const p=audition(),e=reviewEvent(p);
 for(const mutation of [r=>r.measurements.referenceSha256=file().sha256,r=>r.measurements.speakerSimilarity=.99,r=>r.measurements.speakerSimilarityMethod='invented',r=>r.checks.find(c=>c.criterion==='voice-match').status='pass',r=>delete r.measurements.identityBasis]){const forged=structuredClone(e);mutation(forged.review);assert.throws(()=>send(p,'review',{...forged}),/HUMAN_VOICE_IDENTITY_REQUIRED/);}
 
 const p2 = structuredClone(p);
 p2.jobs[0].request = { voice: choice.voiceId };
 p2.jobs[0].result = { voiceId: choice.voiceId };
 const e2 = reviewEvent(p2);
 e2.review.measurements.identityBasis = 'consented-voice-id';
 e2.review.checks.find(c => c.criterion === 'voice-match').status = 'pass';
 e2.review.decision = 'approved';
 const reviewedConsented = send(p2, 'review', {...e2});
 assert.equal(reviewedConsented.gate, 'human');
 
 const e3 = reviewEvent(p2);
 e3.review.measurements.identityBasis = 'human-recognition';
 e3.review.checks.find(c => c.criterion === 'voice-match').status = 'pass';
 assert.throws(()=>send(p2,'review',{...e3}), /HUMAN_VOICE_IDENTITY_REQUIRED/);

 const pBadJob = structuredClone(p2);
 pBadJob.jobs[0].result.voiceId = 'wrong';
 assert.throws(()=>send(pBadJob,'review',{...e2}), /HUMAN_VOICE_IDENTITY_REQUIRED/);

 const reviewed=passReview(p);assert.equal(reviewed.gate,'human');assert.equal(current(reviewed).approvedBy,undefined);
 assert.throws(()=>approved(reviewed));
 const approvedAudition=humanApprove(reviewed);assert.equal(approvedAudition.step,'narration');assert.equal(current(approvedAudition,'audition').humanReview.checks.find(c=>c.criterion==='voice-match').status,'pass');assert.equal(narrationLocked(approvedAudition),false);
});

test('narration lock still requires four measured windows, independent review and explicit human approval without a source recording',()=>{
 let p=humanApprove(passReview(audition()));const sourceFiles=[2,3,4,5].map(n=>file(n,12));
 p=produce(p,{voiceId:choice.voiceId,transcripts:draft.beats.map(b=>b.narration),model:'ISOLATED',sourceFiles,tailSilenceSeconds:[3,3,3,3],files:sourceFiles.map((f,i)=>({...f,path:`/isolated-test/window-${i}.wav`,sha256:String(900+i).padStart(64,'0'),durationSeconds:15}))});
 p=passReview(p);assert.equal(narrationLocked(p),false);assert.throws(()=>assertAllowed(p,'keyframe'),/NARRATION_LOCK_REQUIRED/);p=humanApprove(p);assert.equal(narrationLocked(p),true);assert.equal(p.step,'roster');assert.equal(current(p,'voiceSample'),undefined);
});

test('rejected and inconclusive reviews cannot persist invented source hashes, scores or comparison tool evidence either',()=>{
 const p=audition();
 for(const decision of ['rejected','inconclusive'])for(const mutate of [r=>r.measurements.identityBasis='recorded-reference',r=>r.measurements.referenceSha256='f'.repeat(64),r=>r.measurements.speakerSimilarity=.99,r=>r.measurements.speakerSimilarityMethod='ISOLATED invented method',r=>r.toolEvidence=[{tool:'speakerSimilarity',sha256:current(p).content.files[0].sha256,referenceSha256:'f'.repeat(64)}]]){
  const e=reviewEvent(p);e.review.decision=decision;if(decision==='rejected'){e.review.checks[0].status='fail';e.review.checks[0].repair='ISOLATED repair audible glitch';}mutate(e.review);assert.throws(()=>send(p,'review',{...e}),/HUMAN_VOICE_IDENTITY_REQUIRED/);
 }
 const rejected=reviewEvent(p);rejected.review.decision='rejected';rejected.review.checks[0].status='fail';rejected.review.checks[0].repair='ISOLATED repair an actual audible glitch';assert.equal(send(p,'review',{...rejected}).gate,'produce');
});

test('script revision retains existing clone and resumes at audition instead of asking for an unneeded recording',()=>{
 let p=humanApprove(passReview(audition()));const clone=JSON.stringify(current(p,'clone')),a=current(p,'script');
 p=send(p,'changes',{actor:'human',artifactId:a.id,artifactDigest:a.digest,message:'ISOLATED revise text',impactDigest:revisionImpact(p,a.id).impactDigest});
 p=approved(reviewed(send(p,'artifact',{workerId:'writer',content:draft})));assert.equal(p.step,'audition');assert.equal(current(p,'voiceSample'),undefined);assert.equal(JSON.stringify(current(p,'clone')),clone);
});

test('an optional source supplied before clone selection retains real-reference comparison rather than erasing it',()=>{
 let p=send(start(),'artifact',{actor:'human',workerId:'ISOLATED-human',content:{files:[file()],consent:true,language:'en'}});p=verify(choose(p));
 assert.equal(p.step,'audition');assert.equal(voiceBasis(p).kind,'recorded-reference');assert.deepEqual(current(p,'clone').dependencies,[current(p,'voiceSample').id]);assert.equal(voiceBasis(p).referenceSha256,file().sha256);
});

test('audio instruction correction is explicit, limited to Ava/rubric and forbidden after any provider work',()=>{
 let p=start();const scriptBytes=JSON.stringify(current(p,'script'));
 const change=(p,path)=>{const copy=structuredClone(p);copy.studio.documents[path].content+='\nISOLATED old instruction';copy.studio.documents[path].sha256=sha(Buffer.from(copy.studio.documents[path].content));copy.studio.sha256=digest({config:copy.studio.config,documents:copy.studio.documents});return copy;};
 p=change(p,'crew/ava/SKILL.md');p=send(p,'refresh-audio-instructions',{actor:'human',message:'ISOLATED correct existing-clone review'});assert.equal(JSON.stringify(current(p,'script')),scriptBytes);
 assert.throws(()=>send(change(start(),'crew/leo/SKILL.md'),'refresh-audio-instructions',{actor:'human',message:'ISOLATED'}),/AUDIO_REFRESH_SCOPE/);
 assert.throws(()=>send(start(),'refresh-audio-instructions',{actor:'agent',message:'ISOLATED'}),/human/);
 assert.throws(()=>send(audition(),'refresh-audio-instructions',{actor:'human',message:'ISOLATED'}),/AUDIO_REFRESH_LOCKED/);
});

test('qualified review cannot silently turn missing original-reference identity into an automated pass',()=>{
 let p=verify(choose(start({reviewMode:'qualified',workflowRevision:4})));p=qualifyTestAudio(p);p=produce(p,{files:[file(1)],voiceId:choice.voiceId,transcript:draft.beats[0].narration});const r=reviewEvent(p);r.review.modelVersion='ISOLATED-audio-v1';r.review.capabilityVersion='ISOLATED-tools-v1';r.review.measurements.speakerSimilarity=.99;r.review.measurements.speakerSimilarityMethod='ISOLATED fake comparison';r.review.decision='approved';r.review.checks=r.review.checks.map(c=>({...c,status:'pass'}));assert.throws(()=>send(p,'review',{...r}),/HUMAN_VOICE_IDENTITY_REQUIRED/);
});

test('canonical worker packet includes existing voice basis and actual review broker works without a sample',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-no-sample-broker-'));try{
 const wav=join(dir,'fixture.wav');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:duration=12',wav]);const f=await importMedia(wav,dir);
 let p=ready();p=send(p,'set-budget',{actor:'human',message:'ISOLATED ceiling',budgetLimitUsd:1});p=produce(p,{files:[f],voiceId:choice.voiceId,transcript:draft.beats[0].narration});
 p=send(p,'configure-crew',{actor:'human',message:'ISOLATED bind test crew',crew:{workers:Object.entries(crewRoles).map(([role,{name}])=>({workerId:role==='audio-reviewer'?'audio-reviewer':role,name,role,modelVersion:'ISOLATED-model',capabilityVersion:'ISOLATED-tools',execution:'host'}))}});
 const task=taskFor(p);await assert.rejects(prepareCrewTask(p,{...task,voiceBasis:{...task.voiceBasis,language:'xx'}}),/TASK_INPUT_MISMATCH: voiceBasis/);
 const tools={listenAudio:async()=>({perception:'direct-audio',seconds:12}),transcribe:async()=>({transcript:draft.beats[0].narration,method:'ISOLATED mock transcriber'})};
 const runForBasis = async (project, expectedBasis) => await runCrewTask(project,taskFor(project),{tools,runTask:async(t,{callTool})=>{assert.equal(t.voiceReference,null);assert.equal(t.voiceBasis.language,'en');await assert.rejects(callTool('speakerSimilarity',{sha256:f.sha256,referenceSha256:f.sha256}),/VOICE_REFERENCE_UNAVAILABLE/);for(const name of ['listenAudio','measureAudio','transcribe'])await callTool(name,{sha256:f.sha256});
   const r = reviewEvent(project);
   r.review.measurements.identityBasis = expectedBasis;
   if (expectedBasis === 'consented-voice-id') {
     const identityCheck = r.review.checks.find(c => c.criterion === 'voice-match');
     if (identityCheck) identityCheck.status = 'pass';
     r.review.decision = 'approved'; // every check passes, so the verdict must be approved
   }
   return r;
 }});
 const result=await runForBasis(p, 'consented-voice-id');
 assert.equal(result.review.measurements.identityBasis,'consented-voice-id');assert.equal(result.review.measurements.referenceSha256,undefined);assert.equal(result.review.measurements.speakerSimilarity,undefined);p=send(p,'review',{...result});assert.equal(p.gate,'human');
 
 let pUnverified=ready();pUnverified=send(pUnverified,'set-budget',{actor:'human',message:'ISOLATED ceiling',budgetLimitUsd:1});pUnverified=produce(pUnverified,{files:[f],voiceId:choice.voiceId,transcript:draft.beats[0].narration});
 pUnverified.jobs.find(j => j.status === 'ready').request.voice = 'wrong';
 pUnverified=send(pUnverified,'configure-crew',{actor:'human',message:'ISOLATED bind test crew',crew:{workers:Object.entries(crewRoles).map(([role,{name}])=>({workerId:role==='audio-reviewer'?'audio-reviewer':role,name,role,modelVersion:'ISOLATED-model',capabilityVersion:'ISOLATED-tools',execution:'host'}))}});
 const resultUnverified=await runForBasis(pUnverified, 'human-recognition');
 assert.equal(resultUnverified.review.measurements.identityBasis,'human-recognition');
 pUnverified=send(pUnverified,'review',{...resultUnverified});assert.equal(pUnverified.gate,'human');
 }finally{await rm(dir,{recursive:true});}
});

test('CLI existing-voice default skips recording durably and preserves zero spend after SQLite restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-no-sample-cli-'));let w=openWorkflow(join(dir,'checkpoints.sqlite'));try{
 await w.init('project',inputs);for(const e of captureEvents(start).events)await w.respond('project',e);w.close();w=null;
 const secrets=join(dir,'secrets.env'),mock=join(dir,'mock.mjs'),runner=fileURLToPath(new URL('../runner.mjs',import.meta.url));await writeFile(secrets,'CARTESIA_API_KEY=ISOLATED\n');await writeFile(mock,`globalThis.fetch=async(url,options)=>{if(options.method!=='GET')throw new Error('Forbidden generation');return Response.json(${JSON.stringify({id:choice.voiceId,name:choice.name,language:'en',is_owner:true,status:'active',access:'private'})});};`);
 const result=JSON.parse(execFileSync(process.execPath,['--import',mock,runner,'use-voice','--id',choice.voiceId,'--name',choice.name,'--message','ISOLATED actual clone selection','--consent-message',choice.consentMessage,'--secrets',secrets,'--run',dir],{encoding:'utf8'}));assert.equal(result.pending.step,'audition');assert.equal(result.producer.inputRequest,null);assert.equal(result.jobs.length,0);
 w=openWorkflow(join(dir,'checkpoints.sqlite'));const s=await w.status('project');assert.equal(s.project.voiceChoice.reuseWithoutSample,true);assert.equal(current(s.project,'voiceSample'),undefined);assert.equal(s.project.budget.maxCostUsd,0);assert.equal(s.project.jobs.length,0);
 }finally{w?.close();await rm(dir,{recursive:true});}
});

test('independent STT uses the verified existing-clone language without an original sample or script hint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-no-reference-stt-'));try{
 const wav=join(dir,'fixture.wav'),secrets=join(dir,'secrets.env');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=220:duration=1',wav]);await writeFile(secrets,'CARTESIA_API_KEY=ISOLATED-KEY\n');const file=await importMedia(wav,dir);let calls=0;
 const tools=createCartesiaTranscriptionTool({secretsPath:secrets,receiptDirectory:join(dir,'receipts'),maxCalls:1,fetcher:async(url,options)=>{calls++;assert.equal(options.body.get('language'),'en');assert.equal(options.body.get('prompt'),null);return Response.json({type:'transcript',text:'ISOLATED decoded words',language:'en',duration:file.durationSeconds});}});
 const result=await tools.transcribe({file,worker:{role:'audio-reviewer',workerId:'ISOLATED-ava'},task:{taskId:'ISOLATED-no-reference',voiceReference:null,voiceBasis:{kind:'existing-clone',language:'en'}}});assert.equal(result.language,'en');assert.equal(calls,1);
 }finally{await rm(dir,{recursive:true});}
});

test('crew-review human approval logic', () => {
 const p = audition();
 const p2 = structuredClone(p);
 p2.jobs[0].request = { voice: choice.voiceId };
  p2.jobs[0].result = { voiceId: choice.voiceId };

  // Item 5: verify jobIds uses j.id and is non-empty
 const voiceIdState = consentedVoiceIdentity(p2, current(p2));
 assert.equal(voiceIdState.verified, true);
 assert.equal(voiceIdState.boundVoiceId, choice.voiceId);
 assert.deepEqual(voiceIdState.jobIds, [p2.jobs[0].id]);
 assert.ok(p2.jobs[0].id);

 const e2 = reviewEvent(p2);
 e2.review.measurements.identityBasis = 'consented-voice-id';
 e2.review.checks.find(c => c.criterion === 'voice-match').status = 'pass';
 e2.review.decision = 'approved';
 const reviewedConsented = send(p2, 'review', {...e2});
 
 const crewApprove = {
   decision: 'approved',
   perception: 'crew-review',
    checks: taskFor(p2).criteria.map(c => ({criterion: c, status: 'pass', evidence: 'crew', location: 'file', repair: ''}))
  };

  // Item 1: crew-review without truePeakDb and comfort measurements throws
 assert.throws(() => send(reviewedConsented, 'approve', {actor: 'human', artifactId: current(reviewedConsented).id, artifactDigest: current(reviewedConsented).digest, message: 'approved', humanReview: crewApprove}), /HUMAN_MEDIA_REVIEW_REQUIRED/);

 // Human approve with crew-review succeeds when measurements are present and clean
 const eWithMeasurements = structuredClone(e2);
 eWithMeasurements.review.measurements.truePeakDb = [-6];
 eWithMeasurements.review.measurements.comfort = [{ harshness: false, sibilance: false, clippingOrDistortion: false, suddenSpikes: false }];
 const reviewedWithMeasurements = send(p2, 'review', {...eWithMeasurements});
 const res = send(reviewedWithMeasurements, 'approve', {actor: 'human', artifactId: current(reviewedWithMeasurements).id, artifactDigest: current(reviewedWithMeasurements).digest, message: 'approved', humanReview: crewApprove});
 assert.equal(res.step, 'narration');
 
 // direct-audio still accepted
 const directApprove = structuredClone(crewApprove);
 directApprove.perception = 'direct-audio';
 assert.doesNotThrow(() => send(reviewedWithMeasurements, 'approve', {actor: 'human', artifactId: current(reviewedWithMeasurements).id, artifactDigest: current(reviewedWithMeasurements).digest, message: 'approved', humanReview: directApprove}));

  // unsafe peak evidence can never be recorded as a passing review...
  const eUnsafePeak = structuredClone(eWithMeasurements);
  eUnsafePeak.review.measurements.truePeakDb = [0.5];
  assert.throws(() => send(p2, 'review', {...eUnsafePeak}), /SAFETY_EVIDENCE_MISMATCH/);
  // ...and even a hand-built approved review with an unsafe peak is refused crew-review
  const smuggled = structuredClone(reviewedWithMeasurements);
  current(smuggled).review.measurements.truePeakDb = [0.5];
  assert.throws(() => send(smuggled, 'approve', {actor: 'human', artifactId: current(smuggled).id, artifactDigest: current(smuggled).digest, message: 'approved', humanReview: crewApprove}), /HUMAN_MEDIA_REVIEW_REQUIRED/);

  // rejected if comfort flag true
  const eUnsafeComfort = structuredClone(eWithMeasurements);
  eUnsafeComfort.review.measurements.comfort = [{ harshness: true, sibilance: false, clippingOrDistortion: false, suddenSpikes: false }];
  assert.throws(() => send(p2, 'review', {...eUnsafeComfort}), /SAFETY_EVIDENCE_MISMATCH/);

  // rejected if check fails
  const badApprove = structuredClone(crewApprove);
  badApprove.checks[0].status = 'fail';
  assert.throws(() => send(reviewedWithMeasurements, 'approve', {actor: 'human', artifactId: current(reviewedWithMeasurements).id, artifactDigest: current(reviewedWithMeasurements).digest, message: 'approved', humanReview: badApprove}), /HUMAN_MEDIA_REVIEW_REQUIRED/);

  // item 9 (manual path): an all-pass review marked provisional is rejected
  const eProv = structuredClone(eWithMeasurements);
  eProv.review.decision = 'provisional';
  assert.throws(() => send(p2, 'review', {...eProv}), /REVIEW_VERDICT_MISMATCH/);
});

test('crew-review limited to existing-clone with verified consented voice identity; recorded-sample must use direct-audio', () => {
 const p = audioProject();
 p.step = 'audition';
 p.reviewMode = 'supervised';
 p.gate = 'human';
 const a = current(p);
 a.review = {
   decision: 'approved',
   perception: 'direct-audio',
   modelVersion: 'ISOLATED-model',
   capabilityVersion: 'ISOLATED-tools',
   coverage: { artifactSha256: a.content.files[0].sha256, audioFiles: a.content.files.map(f => ({ sha256: f.sha256, seconds: f.durationSeconds })) },
   checks: taskFor(p).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'ISOLATED', location: 'whole fixture', repair: '' })),
   measurements: {
     transcripts: ['transcript'],
     speechToTextMethod: 'ISOLATED',
     measurementNotes: 'notes',
     speakingRateWpm: [80],
     silenceSeconds: [0],
     identityBasis: 'recorded-reference',
     referenceSha256: current(p, 'voiceSample').content.files[0].sha256,
     speakerSimilarity: 0.95,
     speakerSimilarityMethod: 'ISOLATED',
     truePeakDb: [-6],
     comfort: [{ harshness: false, sibilance: false, clippingOrDistortion: false, suddenSpikes: false }]
   }
 };
 const crewApprove = {
   decision: 'approved',
   perception: 'crew-review',
   checks: taskFor(p).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'crew', location: 'file', repair: '' }))
 };
 // Recorded-reference must reject crew-review
 assert.throws(() => send(p, 'approve', { actor: 'human', artifactId: a.id, artifactDigest: a.digest, message: 'approved', humanReview: crewApprove }), /HUMAN_MEDIA_REVIEW_REQUIRED/);

 // Direct-audio is accepted
 const directApprove = structuredClone(crewApprove);
 directApprove.perception = 'direct-audio';
 assert.doesNotThrow(() => send(p, 'approve', { actor: 'human', artifactId: a.id, artifactDigest: a.digest, message: 'approved', humanReview: directApprove }));
});

test('crew-review rejected when voice ID is not verified', () => {
 const p = audition();
 const p2 = structuredClone(p);
 p2.jobs[0].request = { voice: choice.voiceId };
 p2.jobs[0].result = { voiceId: 'mismatched-voice' }; // wrong voice ID -> verified is false
 const voiceState = consentedVoiceIdentity(p2, current(p2));
 assert.equal(voiceState.verified, false);

 const e2 = reviewEvent(p2);
 e2.review.measurements.identityBasis = 'human-recognition';
 e2.review.measurements.truePeakDb = [-6];
 e2.review.measurements.comfort = [{ harshness: false, sibilance: false, clippingOrDistortion: false, suddenSpikes: false }];
 e2.review.checks.find(c => c.criterion === 'voice-match').status = 'inconclusive';
 e2.review.decision = 'provisional';
 const reviewed = send(p2, 'review', { ...e2 });

 const crewApprove = {
   decision: 'approved',
   perception: 'crew-review',
   checks: taskFor(p2).criteria.map(c => ({ criterion: c, status: 'pass', evidence: 'crew', location: 'file', repair: '' }))
 };
 assert.throws(() => send(reviewed, 'approve', { actor: 'human', artifactId: current(reviewed).id, artifactDigest: current(reviewed).digest, message: 'approved', humanReview: crewApprove }), /HUMAN_MEDIA_REVIEW_REQUIRED/);
});

test('safety inconclusive with clean measurements throws on manual respond path', () => {
 const p = audition();
 const p2 = structuredClone(p);
 p2.jobs[0].request = { voice: choice.voiceId };
 p2.jobs[0].result = { voiceId: choice.voiceId };
 const e2 = reviewEvent(p2);
 e2.review.measurements.identityBasis = 'consented-voice-id';
 e2.review.measurements.truePeakDb = [-6];
 e2.review.measurements.comfort = [{ harshness: false, sibilance: false, clippingOrDistortion: false, suddenSpikes: false }];
 e2.review.checks.find(c => c.criterion === 'safety').status = 'inconclusive';
 e2.review.decision = 'inconclusive';

 assert.throws(() => send(p2, 'review', { ...e2 }), /SAFETY_EVIDENCE_MISMATCH/);
});

test('crew-review rejected for keyframe, video, and film', () => {
 // The approve gate accepts crew-review only via the shared crewReviewEligible
 // predicate, so a false step gate there is a HUMAN_MEDIA_REVIEW_REQUIRED refusal.
 const eligibleReview = {
   decision: 'approved',
   checks: [{criterion: 'integrity', status: 'pass'}],
   measurements: {truePeakDb: [-6], comfort: [{harshness: false, sibilance: false, clippingOrDistortion: false, suddenSpikes: false}]}
 };
 for (const step of ['keyframe', 'video', 'film']) {
   const a = {content: {files: [{sha256: 'f1', durationSeconds: 5}]}, review: eligibleReview};
   assert.equal(crewReviewEligible({step, artifacts: []}, a), false);
 }
});
