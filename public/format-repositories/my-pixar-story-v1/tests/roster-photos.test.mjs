import test from 'node:test';
import assert from 'node:assert/strict';
import {initialProject,taskFor,current} from '../runtime/workflow.mjs';
import {inputs,send,reviewed,file,audioProject} from './helpers.mjs';
import {image} from './background-helpers.mjs';
import {digest} from '../runtime/contracts.mjs';

const proposed=[
 {id:'alex',name:'Alex',ageVariant:'adult',minor:false,storyPurpose:'Leads the memoir.'},
 {id:'bob',name:'Bob',ageVariant:'adult',minor:false,storyPurpose:'Supports the memoir.'},
];
const photo=n=>({path:`/isolated-test/roster-${n}.png`,sha256:String(40+n).padStart(64,'0'),bytes:100,width:1600,height:900});
function rosterProject(){
 let p=audioProject();
 p.reviewMode='supervised';p.workflowRevision=4;
 const s=current(p,'script');s.content={...s.content,proposedCast:proposed};s.digest=digest(s.content);
 p.artifacts.push({id:'roster@1',key:'roster',kind:'roster',version:1,digest:'r',content:{characters:[
  {id:'alex',name:'Alex',ageVariant:'adult',important:true,references:[photo(1)],notes:'ISOLATED alex notes'},
  {id:'bob',name:'Bob',ageVariant:'adult',important:true,references:[],notes:'ISOLATED bob has no photo yet'},
 ]},dependencies:[],valid:true,authoredBy:'cast-owner'});
 p.step='roster';p.gate='review';
 p=reviewed(p);
 assert.equal(p.gate,'human');
 return p;
}
const intake=(bobLike)=>({voiceConsent:true,characters:[
 {id:'alex',name:'Alex',ageVariant:'adult',minor:false,photoRights:true,references:[photo(1)],likeness:'reference',decisionNotes:'ISOLATED alex reference decision'},
 {id:'bob',name:'Bob',ageVariant:'adult',minor:false,photoRights:true,...bobLike},
],resolvedFindings:[]});

test('roster approval stops with a direct photo question when a photo is missing',()=>{
 const p=rosterProject(),a=current(p);
 assert.throws(()=>send(p,'approve',{artifactId:a.id,artifactDigest:a.digest,message:'ISOLATED approve roster',intakeConfirmation:intake({references:[photo(2)],likeness:'reference',decisionNotes:'ISOLATED bob reference decision'})}),e=>/ROSTER_PHOTO_QUESTION/.test(e.message)&&/Bob \(bob\)/.test(e.message));
});

test('an explicit human design-without-photo decision unlocks the roster',()=>{
 const p=rosterProject(),a=current(p);
 const notes='ISOLATED human: design Bob without a photo';
 const q=rosterProject();
 q.artifacts.find(x=>x.id==='roster@1').content.characters.find(c=>c.id==='bob').notes=`ISOLATED bob has no photo yet; ${notes}`;
 const b=current(q);
 const approved=send(q,'approve',{artifactId:b.id,artifactDigest:b.digest,message:'ISOLATED approve roster with interpreted Bob',intakeConfirmation:intake({references:[],likeness:'interpreted',decisionNotes:notes})});
 assert.ok(current(approved,'roster').approvedBy);
 assert.equal(a.id,b.id);
});

test('add-reference binds one photo and invalidates only that character',()=>{
 const notes='ISOLATED human: design Bob without a photo';
 let p=rosterProject();
 p.artifacts.find(x=>x.id==='roster@1').content.characters.find(c=>c.id==='bob').notes=`ISOLATED bob; ${notes}`;
 let b=current(p);
 p=send(p,'approve',{artifactId:b.id,artifactDigest:b.digest,message:'ISOLATED approve roster',intakeConfirmation:intake({references:[],likeness:'interpreted',decisionNotes:notes})});
 // Downstream locks for both characters.
 for(const id of ['alex','bob']){
  p.artifacts.push({id:`characterPrompt:${id}@1`,key:`characterPrompt:${id}`,kind:'characterPrompt',version:1,digest:`cp-${id}`,content:{prompt:'p',characterDigest:'d',referenceHashes:[],recipeSha256:'h'},dependencies:[],valid:true,authoredBy:'t',approvedBy:{message:'m',at:new Date().toISOString()}});
 }
 const extra=photo(9);
 p=send(p,'add-reference',{actor:'human',characterId:'bob',importFile:extra,message:'ISOLATED human adds Bob photo'});
 const roster=current(p,'roster');
 assert.ok(roster.approvedBy);
 assert.deepEqual(roster.content.characters.find(c=>c.id==='bob').references,[extra]);
 assert.deepEqual(roster.content.characters.find(c=>c.id==='alex').references,[photo(1)]);
 assert.equal(current(p,'characterPrompt:alex').approvedBy.message,'m');
 assert.equal(current(p,'characterPrompt:bob'),undefined);
 assert.equal(p.characterId,'bob');assert.equal(p.step,'characterPrompt');assert.equal(p.gate,'author');
});

test('the producer asks the human directly with names and both choices',async()=>{
 const p=rosterProject();
 const {producerUpdate}=await import('../runtime/presentation.mjs');
 const producer=producerUpdate({project:p,pending:taskFor(p)});
 assert.match(producer.message,/Bob \(bob\)/);
 assert.match(producer.message,/add a photo/);
 assert.match(producer.message,/design without a photo/);
});
