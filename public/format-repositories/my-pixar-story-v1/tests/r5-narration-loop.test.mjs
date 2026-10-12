// r5: a narration rejected only on its transcript returns to Ava (audio reviewer)
// once every beat matches or is human-settled, instead of looping to Nora (voice
// director); Ava's skill can refresh during unapproved narration; numbers above
// 99 are spelled out. Pure state tests: no network, no child processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../runtime/contracts.mjs';
import {sha} from '../runtime/media.mjs';
import {current,taskFor,applyEvent} from '../runtime/workflow.mjs';
import {crewRoles} from '../runtime/crew.mjs';
import {transcriptDiff,spokenWords} from '../runtime/evaluators.mjs';
import {audioProject,file,reviewed,event} from './helpers.mjs';

const crew={workers:Object.entries(crewRoles).map(([role,a])=>({role,name:a.name,workerId:`isolated-${role}`,modelVersion:'ISOLATED',capabilityVersion:'ISOLATED',execution:'host'}))};
function transcriptRejected(mishear){
 let p=audioProject();p.step='narration';p.gate='review';const a=current(p);delete a.approvedBy;delete a.review;
 a.content.files=[file(101,10),file(102,10),file(103,10),file(104,10)];a.content.sourceFiles=structuredClone(a.content.files);a.content.tailSilenceSeconds=[0,0,0,0];a.digest=digest(a.content);
 p=reviewed(p,'rejected',{checks:taskFor(p).criteria.map(c=>({criterion:c,status:c==='transcript'?'fail':'pass',location:'ISOLATED beat 2',evidence:'ISOLATED transcript differs',repair:c==='transcript'?'Settle or repair beat 2.':''}))});
 p.crew=crew;
 if(mishear){const r=current(p).review;r.measurements.transcripts[1]='ISOLATED misheard words';}
 return p;
}
const investigation=p=>{const s=current(p).content.files[1];return {audioInvestigation:[{beat:2,sha256:s.sha256,inspection:{durationSeconds:s.durationSeconds,method:'ISOLATED',pauses:[]},transcription:{transcript:'ISOLATED',method:'ISOLATED',words:[{word:'ISOLATED',start:0,end:1}]}}],toolEvidence:['listenAudio','inspectAudio','transcribe'].map(tool=>({tool,sha256:s.sha256,...(tool==='listenAudio'?{seconds:s.durationSeconds}:{})}))};};
const refusal=p=>event(p,'planning-blocked',{workerId:'isolated-voice-director',message:'ISOLATED nothing to cut.',blocker:{kind:'editing-infeasible',beats:[2],problem:'Speech is correct.',solution:'Settle beat 2.',steps:['Settle beat 2.']},...investigation(p)});

test('a settled transcript-only rejection goes back to Ava, not Nora',{timeout:10000},()=>{
 const p=transcriptRejected(true);assert.equal(p.gate,'author');assert.equal(taskFor(p).formatRole,'voice-director');
 const blocked=applyEvent(p,refusal(p));assert.equal(blocked.gate,'escalate');
 const settled=applyEvent(blocked,event(blocked,'settle-transcript',{actor:'human',beat:2,message:'I heard the locked words.'}));
 const resumed=applyEvent(settled,event(settled,'resolve',{actor:'human',message:'Send it back.'}));
 assert.equal(resumed.gate,'review');assert.equal(taskFor(resumed).formatRole,'audio-reviewer');
 // Without a settlement the unsettled beat still goes to the editor as before.
 const unsettled=applyEvent(blocked,event(blocked,'resolve',{actor:'human',message:'Try again.'}));assert.equal(unsettled.gate,'author');
});

test('Nora cannot ask for settlements on beats that already match',{timeout:10000},()=>{
 const p=transcriptRejected(false);assert.equal(p.gate,'author');
 const back=applyEvent(p,refusal(p));assert.equal(back.gate,'review');assert.equal(taskFor(back).formatRole,'audio-reviewer');
 assert.match(back.feedback.at(-1).message,/Ava \(audio reviewer\)/);
});

test('other failed criteria still route to Nora',{timeout:10000},()=>{
 let p=transcriptRejected(false);const r=current(p).review;r.checks.find(c=>c.criterion!=='transcript').status='fail';
 assert.equal(applyEvent(p,refusal(p)).gate,'escalate');
});

test('Ava skill refresh is allowed during unapproved narration only',{timeout:10000},()=>{
 const p=transcriptRejected(true),path='crew/ava/SKILL.md';
 p.studio.documents[path]={content:'ISOLATED old Ava skill',sha256:sha('ISOLATED old Ava skill')};p.studio.sha256=digest({config:p.studio.config,documents:p.studio.documents});const leo=structuredClone(p.studio.documents['crew/leo/SKILL.md']);
 const refreshed=applyEvent(p,event(p,'refresh-audio-instructions',{actor:'human',message:'Use the new Ava skill.'}));
 assert.notEqual(refreshed.studio.documents[path].content,'ISOLATED old Ava skill');assert.deepEqual(refreshed.studio.documents['crew/leo/SKILL.md'],leo);assert.deepEqual(refreshed.studio.config,p.studio.config);assert.equal(refreshed.gate,p.gate);
 const approved=structuredClone(p);current(approved).approvedBy={message:'locked',at:new Date().toISOString()};
 assert.throws(()=>applyEvent(approved,event(approved,'refresh-audio-instructions',{actor:'human',message:'x'})),/AUDIO_REFRESH_LOCKED/);
 const inflight=structuredClone(p);inflight.jobs.push({...structuredClone(inflight.jobs[0]??{}),id:'job-x',status:'submitted'});
 assert.throws(()=>applyEvent(inflight,event(inflight,'refresh-audio-instructions',{actor:'human',message:'x'})),/AUDIO_REFRESH_LOCKED/);
});

test('numbers above 99 read as words; changed values still differ',{timeout:10000},()=>{
 assert.equal(transcriptDiff('Fifty thousand fans cheered.','50,000 fans cheered.').editDistance,0);
 assert.equal(transcriptDiff('fifty thousand','50000').editDistance,0);
 assert.equal(transcriptDiff('one hundred five','105').editDistance,0);
 assert.equal(transcriptDiff('two million three hundred thousand','2,300,000').editDistance,0);
 assert.ok(transcriptDiff('Fifty thousand fans','60,000 fans').editDistance>0);
 assert.deepEqual(spokenWords('007'),['007']);
 assert.equal(transcriptDiff('She came third in 1999.','She came 3rd in nineteen ninety-nine.').editDistance,0);
 assert.equal(transcriptDiff('the twenty first of May','the 21st of May').editDistance,0);
 assert.equal(transcriptDiff('Salt & pepper, 50% off, $5 each','salt and pepper fifty percent off five dollars each').editDistance,0);
 assert.equal(transcriptDiff('In 2026 we moved','In twenty twenty-six we moved').editDistance,0);
 assert.ok(transcriptDiff('She came third','She came 4th').editDistance>0);
 assert.deepEqual(spokenWords('I was 8'),['i','was','eight']);
});

test('LangGraph Studio entry exports the runner graph and langgraph.json points at it',{timeout:10000},async()=>{
 const {graph}=await import('../runtime/studio-graph.mjs');
 const nodes=Object.keys(graph.getGraph().nodes);
 for(const n of ['author','review','human','produce','authorize','collect','escalate','pending'])assert.ok(nodes.includes(n),n);
 const {readFile}=await import('node:fs/promises');
 const cfg=JSON.parse(await readFile(new URL('../langgraph.json',import.meta.url)));
 assert.equal(cfg.graphs['wiggly-my-pixar-story'],'./runtime/studio-graph.mjs:graph');
 assert.equal(cfg.env,'./secrets.env');
});

test('audio transcript quotes are attached by the runtime from transcribe output',{timeout:10000},async()=>{
 const {verifyReviewQuotes}=await import('../runtime/crew.mjs');
 const files=[{sha256:'a'.repeat(64)},{sha256:'b'.repeat(64)}];
 const outputs=new Map([[`transcribe:${files[0].sha256}`,{transcript:'At home I watched Yu-Gi-Oh! GX.'}],[`transcribe:${files[1].sha256}`,{transcript:'50,000 felt like six figures.'}]]);
 const task={step:'narration',artifact:{content:{files}}};
 const review={decision:'approved',checks:[{criterion:'transcript',status:'pass',quotes:['Shaz (standing r4 instruction: feedback note)']}]};
 verifyReviewQuotes({role:'audio-reviewer',task,review,outputs});
 assert.deepEqual(review.checks[0].quotes,['At home I watched Yu-Gi-Oh! GX.','50,000 felt like six figures.']);
 // Other criteria still need the reviewer's own valid quotes.
 const bad={decision:'approved',checks:[{criterion:'delivery',status:'pass',quotes:['Shaz feedback note text']}]};
 assert.throws(()=>verifyReviewQuotes({role:'audio-reviewer',task,review:bad,outputs}),/REVIEW_QUOTE_NOT_FOUND/);
});

test('repair retries re-run required audio perception through the broker',{timeout:10000},async()=>{
 const {reuseRepairPerception}=await import('../runtime/crew.mjs');
 const p={reviewMode:'supervised'},files=[{sha256:'a'.repeat(64)},{sha256:'b'.repeat(64)}];
 const calls=[];const callTool=async(tool,args)=>{calls.push(`${tool}:${args.sha256[0]}`);return {};};
 const base={step:'narration',gate:'review',artifact:{content:{files}}};
 assert.deepEqual(await reuseRepairPerception(p,base,{role:'audio-reviewer'},callTool),[]);
 const reused=await reuseRepairPerception(p,{...base,repairFeedback:{error:'x'}},{role:'audio-reviewer'},callTool);
 assert.equal(reused.length,6);assert.deepEqual(calls.sort(),['listenAudio:a','listenAudio:b','measureAudio:a','measureAudio:b','transcribe:a','transcribe:b']);
 assert.deepEqual(await reuseRepairPerception(p,{...base,repairFeedback:{error:'x'}},{role:'scene-reviewer'},callTool),[]);
});

test('drive defaults: perception estimates exist and are positive',{timeout:10000},async()=>{
 const {PERCEPTION_ESTIMATES_USD}=await import('../runtime/budget.mjs');
 assert.equal(PERCEPTION_ESTIMATES_USD.review,0.02);assert.equal(PERCEPTION_ESTIMATES_USD.transcription,0.005);
});
