import test from 'node:test';
import assert from 'node:assert/strict';
import {initialProject,current} from '../runtime/workflow.mjs';
import {loadStudio} from '../runtime/instructions.mjs';
import {digest} from '../runtime/contracts.mjs';
import {crewRoles} from '../runtime/crew.mjs';
import {CrewHost} from '../runtime/crew-host.mjs';
import {inputs,send,audioProject} from './helpers.mjs';

// A run pinned before the per-agent split: every agent on gpt-6.1-sol, no backend field.
function legacy(p){
 const agents=Object.fromEntries(Object.entries(p.studio.config.agents).map(([role,{backend:_b,...a}])=>[role,{...a,model:'gpt-6.1-sol'}]));
 const config={...p.studio.config,agents},documents=p.studio.documents;
 p.studio={config,documents,sha256:digest({config,documents})};
 return p;
}
const kit=loadStudio().config.agents;
const deepseekRoles=Object.keys(kit).filter(r=>kit[r].backend==='openrouter');
const legacyCrew={workers:Object.keys(crewRoles).map(role=>({workerId:`thread-${role}`,name:crewRoles[role].name,role,modelVersion:'gpt-6.1-sol',capabilityVersion:'old-cap',execution:'host'}))};

test('refresh-crew-models copies only per-agent backend/model into a legacy pinned studio',()=>{
 let p=legacy(initialProject('crew-models',inputs,{workflowRevision:2}));
 const before=structuredClone(p.studio);
 p=send(p,'refresh-crew-models',{actor:'human',message:'ISOLATED move crew to per-agent models'});
 assert.deepEqual(p.studio.documents,before.documents);
 for(const [role,agent] of Object.entries(p.studio.config.agents)){
  assert.equal(agent.backend,kit[role].backend);assert.equal(agent.model,kit[role].model);
  assert.equal(agent.skill,before.config.agents[role].skill);assert.deepEqual(agent.tools,before.config.agents[role].tools);
 }
 assert.equal(p.studio.sha256,digest({config:p.studio.config,documents:p.studio.documents}));
 assert.match(p.history.filter(h=>h.action==='refresh-crew-models').map(h=>h.message).join(' '),/models changed: .*text-reviewer/);
 assert.throws(()=>send(p,'refresh-crew-models',{actor:'human',message:'ISOLATED again'}),/CREW_MODEL_REFRESH_NOOP/);
});

test('refresh-crew-models keeps a supervised reviewer locked by approved media on its pinned model',()=>{
 let p=legacy(audioProject());p.reviewMode='supervised';
 assert.ok(p.artifacts.some(a=>a.valid&&a.approvedBy&&a.content?.files&&['audition','narration'].includes(a.kind)));
 p=send(p,'refresh-crew-models',{actor:'human',message:'ISOLATED move crew'});
 assert.equal(p.studio.config.agents['audio-reviewer'].model,'gpt-6.1-sol');
 assert.equal(p.studio.config.agents['audio-reviewer'].backend,undefined);
 assert.equal(p.studio.config.agents['text-reviewer'].model,kit['text-reviewer'].model);
 assert.match(p.history.filter(h=>h.action==='refresh-crew-models').map(h=>h.message).join(' '),/locked reviewers kept: audio-reviewer/);
});

test('crew-refresh after refresh-crew-models rebinds exactly the moved roles and keeps Sol worker IDs',async()=>{
 let p=legacy(initialProject('crew-models-rebind',inputs,{workflowRevision:2}));
 p=send(p,'refresh-crew-models',{actor:'human',message:'ISOLATED move crew'});
 const codex={tools:{},refreshCrew:async c=>({workers:c.workers.map(w=>({...w,capabilityVersion:'codex-cap'}))}),startRole:async()=>{throw new Error('no codex role should move');}};
 const openrouter={tools:{},refreshCrew:async c=>({workers:c.workers}),startRole:async(role,agent)=>({workerId:`openrouter:${role}:new`,name:agent.name,role,modelVersion:agent.model,capabilityVersion:'or-cap',execution:'host',backend:'openrouter'})};
 const out=await new CrewHost({codex,openrouter,config:p.studio.config}).refreshCrew(legacyCrew,p.studio.config);
 assert.deepEqual([...out.changed].sort(),[...deepseekRoles].sort());
 for(const role of ['script-writer','visual-reviewer','scene-reviewer']){const w=out.workers.find(w=>w.role===role);assert.equal(w.workerId,`thread-${role}`);assert.equal(w.backend,'codex');assert.equal(w.modelVersion,'gpt-6.1-sol');}
 for(const role of deepseekRoles)assert.equal(out.workers.find(w=>w.role===role).modelVersion,'deepseek/deepseek-v4.1-flash');
 // Without refresh-crew-models the legacy pinned config changes nothing.
 const untouched=legacy(initialProject('crew-models-none',inputs,{workflowRevision:2}));
 const none=await new CrewHost({codex,openrouter,config:untouched.studio.config}).refreshCrew(legacyCrew,untouched.studio.config);
 assert.deepEqual(none.changed,[]);
});
