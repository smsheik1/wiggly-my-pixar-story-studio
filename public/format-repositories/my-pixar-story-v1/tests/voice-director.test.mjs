import test from 'node:test';
import assert from 'node:assert/strict';
import { roleFor, crewRoles } from '../runtime/crew.mjs';
import { createAudioEditTools } from '../runtime/audio-edit.mjs';
import { audioProject, file, reviewed } from './helpers.mjs';
import { current, taskFor } from '../runtime/workflow.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importMedia } from '../runtime/media.mjs';

test('roleFor: Nora (voice-director) owns narration/author, Ava (audio-reviewer) reviews, Eli keeps editPlan', () => {
  assert.equal(roleFor({step:'narration',gate:'author'}), 'voice-director');
  assert.equal(roleFor({step:'narration',gate:'review'}), 'audio-reviewer');
  assert.equal(roleFor({step:'audition',gate:'review'}), 'audio-reviewer');
  assert.equal(roleFor({step:'audition',gate:'author'}), 'orchestrator');
  assert.equal(roleFor({step:'editPlan',gate:'author'}), 'film-editor');
});

test('narration editing permission moved to voice-director; film-editor is denied', async () => {
  const dir=await mkdtemp(join(tmpdir(),'memoir-voice-director-edit-'));
  try{
    const path=join(dir,'source.wav');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=500:duration=17.2:sample_rate=44100','-af',"volume=0:enable='between(t,6,10)'",path]);
    const source=await importMedia(path,dir);
    const tools=createAudioEditTools({runDir:dir});

    let p = audioProject(); p.step = 'narration'; p.gate = 'review';
    const a = current(p); delete a.approvedBy; delete a.review;
    a.content.files = [file(101,15), source, file(103,15), file(104,15)];
    a.content.sourceFiles = structuredClone(a.content.files);
    a.content.tailSilenceSeconds = [0,0,0,0];

    p = reviewed(p, 'rejected', { repairTarget: 'script', checks: taskFor(p).criteria.map(c=>({criterion:c,status:c==='duration'?'fail':'pass',location:'ISOLATED beat 2',evidence:'ISOLATED 17.2s',repair:c==='duration'?'Try local pause shortening.':''})) });
    const task = taskFor(p);

    const plan={kind:'pause-shortening',keepRanges:[{startSeconds:0,endSeconds:7},{startSeconds:9.2,endSeconds:17.2}],reason:'ISOLATED'};

    const workerEli = {role: 'film-editor', name: 'Eli', workerId: 'eli-1'};
    const argsEli = {file:source, task, worker:workerEli, edit:plan};
    await assert.rejects(tools.renderAudioEdit(argsEli), /AUDIO_EDIT_SCOPE_DENIED/);

    const workerNora = {role: 'voice-director', name: 'Nora', workerId: 'nora-1'};
    const argsNora = {file:source, task, worker:workerNora, edit:plan};
    const resultNora = await tools.renderAudioEdit(argsNora);
    assert.equal(resultNora.beat, 2);
  }finally{
    await rm(dir,{recursive:true});
  }
});
