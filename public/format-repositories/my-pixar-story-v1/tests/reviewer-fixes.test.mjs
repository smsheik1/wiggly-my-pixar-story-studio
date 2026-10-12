import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {criteria} from '../runtime/contracts.mjs';
import {verifyReviewRecommendation} from '../runtime/crew.mjs';
import {initialProject,taskFor,current} from '../runtime/workflow.mjs';
import {importMedia} from '../runtime/media.mjs';
import {digest} from '../runtime/contracts.mjs';
import {inputs,send} from './helpers.mjs';
import {image} from './background-helpers.mjs';

test('background reviews require the story-specific-set criterion',()=>{
 assert.ok(criteria.backgroundCandidates.includes('story-specific-set'));
 assert.ok(criteria.backgroundAngle.includes('story-specific-set'));
});

test('baked-in text fails sheets and backgrounds',async()=>{
 const vera=await readFile(new URL('../crew/vera/SKILL.md',import.meta.url),'utf8');
 const visual=await readFile(new URL('../evaluation/rubrics/visual.md',import.meta.url),'utf8');
 assert.match(vera,/baked-in text/i);assert.match(visual,/baked-in text/i);
 assert.match(visual,/expression names?/);
 assert.match(visual,/fails `style`.*\[R-SHEET-NO-TEXT\]|on a character sheet fails `style`/);
 assert.match(visual,/fails `story-specific-set`.*\[L-MIN-TEXT\]|in a background plate fails `story-specific-set`/);
});

test('multi-option reviews must rank options and recommend exactly one passing index',()=>{
 const task={step:'candidates',artifact:{content:{files:[{},{},{}]}}};
 assert.throws(()=>verifyReviewRecommendation({task,review:{decision:'approved',checks:[{status:'pass'}]}}),/RECOMMENDATION_MISSING/);
 assert.throws(()=>verifyReviewRecommendation({task,review:{decision:'approved',checks:[{status:'pass'}],recommendation:{selection:5,ranking:[5],reason:'x'}}}),/RECOMMENDATION_MISSING/);
 assert.throws(()=>verifyReviewRecommendation({task,review:{decision:'approved',checks:[{status:'pass'}],recommendation:{selection:0,ranking:[1],reason:'x'}}}),/RECOMMENDATION_MISSING/);
 verifyReviewRecommendation({task,review:{decision:'approved',checks:[{status:'pass'}],recommendation:{selection:2,ranking:[2,0,1],reason:'Option 3 stages the action best.'}}});
 // Failing reviews need no recommendation.
 verifyReviewRecommendation({task,review:{decision:'rejected',checks:[{status:'fail'}]}});
});

test('review gate refuses a passing multi-option review without a recommendation',()=>{
 let p=initialProject('rec-gate',inputs,{workflowRevision:4,reviewMode:'supervised'});
 p.artifacts.push({id:'script@1',key:'script',kind:'script',version:1,digest:'s',content:{beats:[1,2,3,4].map(i=>({beat:i,durationSeconds:15,narration:'x',emotionalPurpose:'c',sourceAnswers:['scene1Childhood']})),commonSenseChecks:[]},dependencies:[],valid:true,authoredBy:'t'});
 p.artifacts.push({id:'roster@1',key:'roster',kind:'roster',version:1,digest:'r',content:{characters:[{id:'alex',name:'Alex',ageVariant:'adult',important:true,references:[image(1)],notes:'x'}]},dependencies:[],valid:true,authoredBy:'t'});
 p.artifacts.push({id:'characterPrompt:alex@1',key:'characterPrompt:alex',kind:'characterPrompt',version:1,digest:'c',content:{prompt:'character',characterDigest:'d',referenceHashes:[image(1).sha256],recipeSha256:'h'},dependencies:[],valid:true,authoredBy:'t'});
 const files=[1,2,3].map(n=>({path:`/isolated-test/sheet-${n}.png`,sha256:String(n).padStart(64,'0'),bytes:100,width:1200,height:900}));
 p.artifacts.push({id:'candidates:alex@1',key:'candidates:alex',kind:'candidates',version:1,digest:digest({files,prompt:'character'}),content:{files,prompt:'character'},dependencies:[],valid:true,authoredBy:'provider-runtime'});
 p.characterId='alex';p.step='candidates';p.gate='review';
 const a=current(p);
 const base={decision:'approved',perception:'direct-image',checks:criteria.candidates.map(criterion=>({criterion,status:'pass',location:'ISOLATED',evidence:'x'})),toolEvidence:files.map(f=>({tool:'viewImage',sha256:f.sha256}))};
 assert.throws(()=>send(p,'review',{workerId:'vera',artifactId:a.id,artifactDigest:a.digest,review:base}),/RECOMMENDATION_MISSING/);
 const ok=send(p,'review',{workerId:'vera',artifactId:a.id,artifactDigest:a.digest,review:{...base,recommendation:{selection:2,ranking:[2,0,1],reason:'ISOLATED option 3 stages the action best.'}}});
 assert.equal(ok.gate,'human');
});

test('status and present output show the recommendation to the human',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'memoir-rec-present-'));
 try{
  const mk=async(name,color)=>{const pth=join(dir,name);execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=1200x900`,'-frames:v','1',pth]);return importMedia(pth,dir);};
  const files=[await mk('r0.png','red'),await mk('r1.png','green'),await mk('r2.png','blue')];
  let p=initialProject('rec-present',inputs,{workflowRevision:4,reviewMode:'qualified'});
  p.artifacts.push({id:'script@1',key:'script',kind:'script',version:1,digest:'s',content:{beats:[1,2,3,4].map(i=>({beat:i,durationSeconds:15,narration:'x',emotionalPurpose:'c',sourceAnswers:['scene1Childhood']})),commonSenseChecks:[]},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
  p.artifacts.push({id:'roster@1',key:'roster',kind:'roster',version:1,digest:'r',content:{characters:[{id:'alex',name:'Alex',ageVariant:'adult',important:true,references:[files[0]],notes:'x'}]},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
  p.artifacts.push({id:'characterPrompt:alex@1',key:'characterPrompt:alex',kind:'characterPrompt',version:1,digest:'c',content:{prompt:'character',characterDigest:'d',referenceHashes:[files[0].sha256],recipeSha256:'h'},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
  p.artifacts.push({id:'candidates:alex@1',key:'candidates:alex',kind:'candidates',version:1,digest:digest({files,prompt:'character'}),content:{files,prompt:'character'},dependencies:[],valid:true,authoredBy:'provider-runtime'});
  p.characterId='alex';p.step='candidates';p.gate='review';
  const a=current(p);
  p=send(p,'review',{workerId:'vera',artifactId:a.id,artifactDigest:a.digest,review:{decision:'approved',perception:'direct-image',checks:criteria.candidates.map(criterion=>({criterion,status:'pass',location:'ISOLATED',evidence:'x'})),recommendation:{selection:1,ranking:[1,2,0],reason:'ISOLATED option 2 holds the likeness best.'},toolEvidence:files.map(f=>({tool:'viewImage',sha256:f.sha256}))}});
  assert.equal(p.gate,'human');
  const status={project:p,pending:taskFor(p)};
  const {producerUpdate,presentDeliverable}=await import('../runtime/presentation.mjs');
  const producer=producerUpdate(status);
  assert.match(producer.message,/Vera recommends Option 2: ISOLATED option 2 holds the likeness best/);
  const presented=await presentDeliverable(status);
  assert.equal(presented.recommendation.text,'Vera recommends Option 2: ISOLATED option 2 holds the likeness best.');
 }finally{await rm(dir,{recursive:true});}
});

test('left/right is anatomical and the quick-pass hand rule is unchanged',async()=>{
 const vera=await readFile(new URL('../crew/vera/SKILL.md',import.meta.url),'utf8');
 const june=await readFile(new URL('../crew/june/SKILL.md',import.meta.url),'utf8');
 const visual=await readFile(new URL('../evaluation/rubrics/visual.md',import.meta.url),'utf8');
 assert.match(vera,/character's own/,'vera must judge sides anatomically');
 assert.match(vera,/In a front view, a watch on the character's left wrist sits on the viewer's right/,'vera must state the front-view rule');
 for(const [name,content] of [['june',june],['visual',visual]]){
  assert.match(content,/character's OWN (side|\(anatomical\) side)/i,`${name} must judge sides anatomically`);
  assert.match(content,/front view the character's right is on the viewer's left/,`${name} must state the front-view rule`);
 }
 assert.match(vera,/Fingers too small to count pass/);
 assert.match(june,/Too small to count is a PASS/);
 assert.match(visual,/too small to count and nothing looks wrong, anatomy is a PASS/);
});
