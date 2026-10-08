import test from 'node:test';
import assert from 'node:assert/strict';
import { roleFor, crewRoles } from '../runtime/crew.mjs';
import { loadStudio } from '../runtime/instructions.mjs';
import { assertAllowed, keyFor, current } from '../runtime/gates.mjs';
import { reviewed, approved, send } from './helpers.mjs';
import { keyframeProject, promptLocked, generated } from './shot-helpers.mjs';
test('Review routing per reviewer', () => {
  assert.equal(roleFor({step:'keyframe', gate:'review'}), 'scene-reviewer');
  assert.equal(roleFor({step:'video', gate:'review'}), 'scene-reviewer');
  assert.equal(roleFor({step:'film', gate:'review', artifacts: []}), 'scene-reviewer');
  assert.equal(roleFor({step:'film', gate:'review', artifacts: [{key:'film', valid:true, visualReview:{decision:'approved'}}]}), 'audio-reviewer');
  
  assert.equal(roleFor({step:'candidates', gate:'review'}), 'visual-reviewer');
  assert.equal(roleFor({step:'sheet', gate:'review'}), 'visual-reviewer');
  assert.equal(roleFor({step:'backgroundCandidates', gate:'review'}), 'visual-reviewer');
  assert.equal(roleFor({step:'backgroundAngle', gate:'review'}), 'visual-reviewer');
});

test('Theo/Pia/June boundaries', () => {
  const steps = ['answers', 'characterPrompt', 'script', 'voiceSample', 'clone', 'audioReviewerQualification', 'audition', 'narration', 'roster', 'candidates', 'sheetPrompt', 'sheet', 'backgrounds', 'backgroundBrief', 'backgroundPrompt', 'backgroundCandidates', 'backgroundAngleBrief', 'backgroundAnglePrompt', 'backgroundAngle', 'shotIntentions', 'shots', 'keyframePrompt', 'keyframe', 'video', 'reviewerQualification', 'videoPlan', 'videoPrompt', 'soundPlan', 'music', 'effect', 'editPlan', 'film', 'complete'];
  for (const step of steps) {
    const revRole = roleFor({step, gate:'review', artifacts:[]});
    assert.notEqual(revRole, 'pixar-prompter');
    assert.notEqual(revRole, 'sheet-prompter');
  }
  
  assert.equal(roleFor({step:'backgroundPrompt', gate:'author'}), 'pixar-prompter');
  assert.equal(roleFor({step:'backgroundAnglePrompt', gate:'author'}), 'pixar-prompter');
  assert.equal(roleFor({step:'sheetPrompt', gate:'author'}), 'sheet-prompter');
  
  const studio = loadStudio();
  assert.equal(studio.config.agents['pixar-prompter'].name, 'Theo');
  assert.equal(studio.config.agents['sheet-prompter'].name, 'Pia');
  assert.equal(studio.config.agents['scene-reviewer'].name, 'June');
  assert.equal(studio.config.agents['visual-reviewer'].name, 'Vera');
  
  const authorRoles = new Set();
  for (const step of steps) {
    authorRoles.add(roleFor({step, gate:'author', artifacts:[]}));
  }
  assert.ok(!authorRoles.has('text-reviewer'));
  assert.ok(!authorRoles.has('audio-reviewer'));
  assert.ok(!authorRoles.has('visual-reviewer'));
  assert.ok(!authorRoles.has('scene-reviewer'));
});

test('Qualification moved to June in unsupervised mode', () => {
  let p = keyframeProject();
  // Get to reviewerQualification
  const shotPlan = current(p, 'shots').content;
  for(const shot of shotPlan.shots) {
    p = approved(reviewed(generated(promptLocked(p))));
  }
  assert.equal(p.step, 'reviewerQualification');
  assert.equal(p.gate, 'author');
  
  assert.throws(() => assertAllowed(p, 'video'), /VISUAL_REVIEWER_NOT_QUALIFIED/);
  
  const sceneWorkerId = 'host-scene-reviewer';
  const visualWorkerId = 'host-visual-reviewer';
  
  const baseQual = {
    datasetDigest:'isolated-visual-labels',
    predictionDigest:'isolated-visual-predictions',
    qualifiedScopes:['image', 'video'],
    qualified:true,
    verifiedMedia:true,
    cases:24,
    evaluatedAt:'2026-10-02T00:00:00Z',
    productionApproval:false,
    evidenceDirectory:'/isolated-test/visual-qualification',
    metrics: [
      {kind:'image',criterion:'anatomy'},{kind:'image',criterion:'identity'},{kind:'image',criterion:'continuity'},
      {kind:'video',criterion:'anatomy'},{kind:'video',criterion:'identity'},{kind:'video',criterion:'continuity'}
    ].map(m=>({...m,passes:2,defects:2,errors:0,qualified:true}))
  };

  // Now bind to scene-reviewer (correct!)
  let goodP = approved(reviewed(send(p, 'qualified', {
    actor: 'runtime',
    content: {
      ...baseQual,
      workerId: sceneWorkerId,
      modelVersion: 'inherit-current-test-host',
      capabilityVersion: 'isolated-tools-v1'
    }
  })));
  
  // Set up crew AFTER artifact generation so helpers don't fail CREW_PERMISSION_DENIED
  const audioQ = goodP.artifacts.find(a => a.kind === 'audioReviewerQualification')?.content;
  goodP.crew = {
    workers: Object.keys(crewRoles).map(role=>({
      workerId: role === 'audio-reviewer' && audioQ ? audioQ.workerId : `host-${role}`,
      name: crewRoles[role].name,
      role,
      modelVersion: role === 'audio-reviewer' && audioQ ? audioQ.modelVersion : 'inherit-current-test-host',
      capabilityVersion: role === 'audio-reviewer' && audioQ ? audioQ.capabilityVersion : 'isolated-tools-v1',
      execution: 'host'
    }))
  };
  
  // Clone and change the artifact to use visualWorkerId instead of sceneWorkerId (wrong!)
  let badP = structuredClone(goodP);
  const a = badP.artifacts.find(art => art.kind === 'reviewerQualification');
  a.content.workerId = visualWorkerId;
  assert.throws(() => assertAllowed(badP, 'video'), /VISUAL_REVIEWER_NOT_QUALIFIED/);
  
  // Now we can go to videoPlan
  goodP.step = 'videoPlan';
  assertAllowed(goodP, 'videoPlan'); // should not throw VISUAL_REVIEWER_NOT_QUALIFIED
});
