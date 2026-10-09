import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {loadStudio} from '../runtime/instructions.mjs';
import {digest,criteria} from '../runtime/contracts.mjs';
import {current} from '../runtime/workflow.mjs';
import {audioProject,inputs,file,send,reviewed,approved} from './helpers.mjs';
import {image} from './background-helpers.mjs';

const sha=s=>createHash('sha256').update(s).digest('hex');

function candidatesProduce(){
 let p=audioProject();
 p=send(p,'artifact',{workerId:'cast-owner',content:{characters:[{id:'alex',name:'Alex',ageVariant:'adult',important:true,references:[image(1)],notes:'ISOLATED'}]}});
 p=reviewed(p);
 p=approved(p);
 assert.equal(p.step,'candidates');
 assert.equal(p.gate,'produce');
 return p;
}

test('June keyframe skill fails photoreal style and uses the quick-pass hand rule',()=>{
 const kit=loadStudio();
 const june=kit.documents['crew/june/SKILL.md'].content,scene=kit.documents['evaluation/rubrics/scene.md'].content;
 for(const doc of [june,scene]){
  assert.match(doc,/Pixar-like 3D/);
  assert.match(doc,/photoreal\/3D hybrid/);
  assert.match(doc,/fails? `style`/i);
  assert.match(doc,/quick normal pass/);
  assert.match(doc,/too small to count/);
 }
 assert.match(june,/Never pass photoreal style to protect likeness/);
 assert.match(june,/photographic skin texture/);
 assert.match(june,/real-human facial structure/);
 assert.match(june,/photographic lighting\/depth-of-field/);
 assert.match(scene,/Likeness never excuses realism/);
 assert.doesNotMatch(june,/5 fingers per hand/);
 assert.doesNotMatch(june,/Zero tolerance/);
 assert.doesNotMatch(june,/five distinct fingers/);
});

test('refresh-keyframe-instructions replaces only June skill and scene rubric on an older pinned run',()=>{
 const kit=loadStudio();
 let p=candidatesProduce();
 const pin=(path,extra)=>{const content=kit.documents[path].content+extra;p.studio.documents[path]={content,sha256:sha(content)};};
 pin('crew/leo/SKILL.md','\n<!-- isolated old leo -->');
 pin('crew/max/SKILL.md','\n<!-- isolated old max -->');
 pin('crew/vera/SKILL.md','\n<!-- isolated old vera -->');
 pin('evaluation/rubrics/visual.md','\n<!-- isolated old visual -->');
 pin('crew/june/SKILL.md','\n<!-- isolated old june -->');
 pin('evaluation/rubrics/scene.md','\n<!-- isolated old scene -->');
 p.studio.config={...p.studio.config,generation:{...p.studio.config.generation,image:{...p.studio.config.generation.image,model:'muse-image-1.0-pinned'}}};
 p.studio.sha256=digest({config:p.studio.config,documents:p.studio.documents});
 const before=structuredClone(p.studio);
 p=send(p,'refresh-keyframe-instructions',{actor:'human',message:'ISOLATED refresh June ahead of keyframes'});
 assert.equal(p.studio.documents['crew/june/SKILL.md'].content,kit.documents['crew/june/SKILL.md'].content);
 assert.equal(p.studio.documents['evaluation/rubrics/scene.md'].content,kit.documents['evaluation/rubrics/scene.md'].content);
 for(const path of Object.keys(before.documents))if(!['crew/june/SKILL.md','evaluation/rubrics/scene.md'].includes(path))assert.deepEqual(p.studio.documents[path],before.documents[path],path);
 assert.deepEqual(p.studio.config,before.config);
 assert.deepEqual(Object.keys(p.studio.documents).sort(),Object.keys(before.documents).sort());
 assert.equal(p.studio.sha256,digest({config:p.studio.config,documents:p.studio.documents}));
});

test('refresh-keyframe-instructions refuses without message, non-human actor, outstanding jobs, or approved item',()=>{
 let p=candidatesProduce();
 assert.throws(()=>send(p,'refresh-keyframe-instructions',{actor:'human'}),/KEYFRAME_REFRESH_LOCKED/);
 assert.throws(()=>send(p,'refresh-keyframe-instructions',{actor:'agent',workerId:'x',message:'ISOLATED'}),/human/);
 // Outstanding uncertain job at an otherwise allowed gate.
 let blocked=candidatesProduce();
 blocked=send(blocked,'plan',{plan:{provider:'meta-muse',operation:'candidates',estimatedCostUsd:0.03,parameters:{prompt:'ISOLATED'}}});
 const job=blocked.jobs.at(-1);
 blocked=send(blocked,'authorize',{jobId:job.id,artifactDigest:job.digest,message:'ISOLATED authorize'});
 blocked=send(blocked,'begin',{jobId:job.id,artifactDigest:job.digest});
 blocked=send(blocked,'provider-error',{jobId:job.id,artifactDigest:job.digest,message:'ISOLATED provider blew up'});
 assert.equal(blocked.jobs.at(-1).status,'uncertain');
 assert.throws(()=>send(blocked,'refresh-keyframe-instructions',{actor:'human',message:'ISOLATED'}),/KEYFRAME_REFRESH_LOCKED/);
 // Approved current item.
 let locked=candidatesProduce();
 const files=[1,2,3].map(n=>({path:`/isolated-test/cand-${n}.png`,sha256:file(n).sha256,bytes:100,width:1200,height:900}));
 locked.artifacts.push({id:'candidates:alex@1',key:'candidates:alex',kind:'candidates',version:1,digest:digest({files,prompt:'x'}),content:{files,prompt:'x'},dependencies:[],valid:true,authoredBy:'provider-runtime',approvedBy:{message:'m',at:new Date().toISOString()},review:{decision:'approved',perception:'direct-image',checks:criteria.candidates.map(criterion=>({criterion,status:'pass',location:'x',evidence:'x'}))}});
 assert.throws(()=>send(locked,'refresh-keyframe-instructions',{actor:'human',message:'ISOLATED'}),/KEYFRAME_REFRESH_LOCKED/);
});

test('refresh-keyframe-instructions refuses when a path is unbound',()=>{
 let p=candidatesProduce();
 delete p.studio.documents['crew/june/SKILL.md'];
 assert.throws(()=>send(p,'refresh-keyframe-instructions',{actor:'human',message:'ISOLATED'}),/KEYFRAME_REFRESH_SCOPE|Missing pinned instruction/);
});
