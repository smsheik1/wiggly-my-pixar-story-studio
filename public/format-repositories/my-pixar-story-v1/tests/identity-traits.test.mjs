import test from 'node:test';
import assert from 'node:assert/strict';
import {current} from '../runtime/workflow.mjs';
import {send,reviewed,audioProject} from './helpers.mjs';
import {digest,Content,IntakeConfirmation} from '../runtime/contracts.mjs';
import {identityFollowUp,identityQuestionsFor,RELIGION_QUESTION,assertReviewChecksTraits,assertPromptKeepsTraits} from '../runtime/identity.mjs';
import {readFileSync} from 'node:fs';

const kit=new URL('../',import.meta.url);
const photo=n=>({path:`/isolated-test/identity-${n}.png`,sha256:String(70+n).padStart(64,'0'),bytes:100,width:1600,height:900});
const proposed=[{id:'mother',name:'Mother',ageVariant:'adult',minor:false,storyPurpose:'Raises the family.'}];
function rosterProject(rosterMustKeep){
 let p=audioProject();
 p.reviewMode='supervised';p.workflowRevision=4;
 const s=current(p,'script');s.content={...s.content,proposedCast:proposed};s.digest=digest(s.content);
 p.artifacts.push({id:'roster@1',key:'roster',kind:'roster',version:1,digest:'r',content:{characters:[
  {id:'mother',name:'Mother',ageVariant:'adult',important:true,references:[photo(1)],notes:'ISOLATED mother notes',...(rosterMustKeep?{mustKeep:rosterMustKeep}:{})},
 ]},dependencies:[],valid:true,authoredBy:'cast-owner'});
 p.step='roster';p.gate='review';
 return reviewed(p);
}
const intake=mustKeep=>({voiceConsent:true,characters:[{id:'mother',name:'Mother',ageVariant:'adult',minor:false,photoRights:true,references:[photo(1)],likeness:'reference',decisionNotes:'ISOLATED reference decision',mustKeep}],resolvedFindings:[]});
const approve=(p,mk)=>{const a=current(p);return send(p,'approve',{artifactId:a.id,artifactDigest:a.digest,message:'ISOLATED approve roster',intakeConfirmation:intake(mk)});};

// ---- intake follow-up ----
test('intake asks the religion question once per story, optional and free text',()=>{
 const q=JSON.parse(readFileSync(new URL('questionnaire.json',kit),'utf8'));
 assert.deepEqual(q.storyQuestions.map(x=>[x.id,x.once,x.optional,x.prompt]),[['religiousHousehold','story',true,RELIGION_QUESTION.prompt]]);
 assert.equal(q.personFollowUps[0].prompt,"Anything they always wear or that's always part of how they look?");
 assert.deepEqual(identityQuestionsFor({inputs:{}},{kind:'script'}).map(x=>x.id),['religiousHousehold']);
 assert.deepEqual(identityQuestionsFor({inputs:{religiousHousehold:'Muslim'}},{kind:'script'}),[],'not asked again once answered');
});
test('per-person follow-up suggests from the religion answer but never assumes',()=>{
 const muslim=identityFollowUp({religion:'Muslim',person:{id:'mother',name:'Mother',gender:'female'}});
 assert.equal(muslim.prompt,"Anything they always wear or that's always part of how they look?");
 assert.deepEqual(muslim.suggestions,['Did she wear a hijab?']);
 assert.deepEqual(muslim.assumed,[]);
 assert.deepEqual(identityFollowUp({religion:'Sikh',person:{gender:'male'}}).suggestions,['Did he wear a turban (dastar)?']);
 assert.deepEqual(identityFollowUp({religion:null,person:{name:'X'}}).suggestions,[]);
 assert.deepEqual(identityFollowUp({religion:'none really',person:{name:'X'}}).suggestions,[]);
 const roster={kind:'roster',content:{characters:[{id:'mother',name:'Mother'},{id:'dad',name:'Dad'}]}};
 const qs=identityQuestionsFor({inputs:{religiousHousehold:'Muslim'}},roster);
 assert.deepEqual(qs.map(x=>x.personId),['mother','dad'],'answers are per person');
 assert.ok(qs.every(x=>x.assumed.length===0));
});
test('contracts carry mustKeep on intake and roster entries, absent meaning none',()=>{
 assert.deepEqual(IntakeConfirmation.parse(intake(['hijab'])).characters[0].mustKeep,['hijab']);
 assert.equal(IntakeConfirmation.parse(intake(undefined)).characters[0].mustKeep,undefined);
 const r=Content.roster.parse({characters:[{id:'mother',name:'Mother',ageVariant:'adult',important:true,references:[],notes:'n',mustKeep:['hijab']}]});
 assert.deepEqual(r.characters[0].mustKeep,['hijab']);
});

// ---- Cleo copy ----
test('roster approval refuses a roster that drops a confirmed intake trait',()=>{
 assert.throws(()=>approve(rosterProject(),['deep teal hijab']),/MUST_KEEP_NOT_COPIED: .*Mother \(mother\): "deep teal hijab"/);
 assert.throws(()=>approve(rosterProject(['glasses']),['deep teal hijab','glasses']),/MUST_KEEP_NOT_COPIED/);
});
test('roster approval passes when Cleo copied every trait, and with no traits at all',()=>{
 assert.ok(current(approve(rosterProject(['deep teal hijab']),['deep teal hijab']),'roster').approvedBy);
 assert.ok(current(approve(rosterProject(),undefined),'roster').approvedBy);
});

// ---- Pia / Cam prompts ----
test('sheet and keyframe prompts must write every mustKeep trait',()=>{
 assert.throws(()=>assertPromptKeepsTraits('Stylized sheet of the woman, teal dress.',[{id:'mother',name:'Mother',mustKeep:['hijab']}]),/MUST_KEEP_MISSING_FROM_PROMPT: .*Mother: "hijab"/);
 assert.doesNotThrow(()=>assertPromptKeepsTraits('Wardrobe: deep teal Hijab fully covering hair in every figure.',[{id:'mother',name:'Mother',mustKeep:['hijab']}]));
 assert.doesNotThrow(()=>assertPromptKeepsTraits('anything',[{id:'dad'}]));
});

// ---- Vera rejection ----
const review=(decision,likeness)=>({decision,checks:[{criterion:'likeness',...likeness},{criterion:'style',status:'pass',evidence:'ok',location:'all',repair:''}]});
test('Vera cannot pass likeness on a sheet without confirming each mustKeep trait',()=>{
 const castEntry={id:'mother',name:'Mother',mustKeep:['hijab']};
 assert.throws(()=>assertReviewChecksTraits(review('approved',{status:'pass',evidence:'Face, skin and teal dress match the photo.'}),castEntry),/MUST_KEEP_UNCHECKED: .*"hijab".*fail `likeness`/);
 assert.doesNotThrow(()=>assertReviewChecksTraits(review('approved',{status:'pass',evidence:'Face matches; the hijab covers the hair in every figure.'}),castEntry));
 assert.doesNotThrow(()=>assertReviewChecksTraits(review('rejected',{status:'fail',evidence:'Option 1 drops the hijab in the profile view.',repair:'Restate the hijab in every figure.'}),castEntry),'a likeness rejection is the expected outcome');
 assert.doesNotThrow(()=>assertReviewChecksTraits(review('approved',{status:'pass',evidence:'Face matches.'}),{id:'dad'}),'no traits, nothing to check');
});
test('skills, rubric and craft guide carry the generic must-keep rule, with no hard-coded hijab in shared rules',()=>{
 const read=f=>readFileSync(new URL(f,kit),'utf8');
 assert.match(read('craft-guide.md'),/\[C-MUST-KEEP\] \(check: vera, sage\) Identity traits from intake stay fixed in every view/);
 assert.doesNotMatch(read('craft-guide.md'),/hijab/i);
 assert.match(read('crew/cleo/SKILL.md'),/mustKeep/);
 assert.match(read('crew/pia/SKILL.md'),/task\.castEntry\.mustKeep/);
 assert.match(read('crew/vera/SKILL.md'),/fails `likeness`/);
 assert.match(read('evaluation/rubrics/visual.md'),/C-MUST-KEEP/);
});
