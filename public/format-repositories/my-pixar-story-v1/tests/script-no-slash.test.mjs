import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { findSlashAbbreviations } from '../runtime/script-lint.mjs';
import { crewRoles, runCrewTask } from '../runtime/crew.mjs';
import { initialProject, taskFor, applyEvent } from '../runtime/workflow.mjs';
import { event, inputs, script, send } from './helpers.mjs';

const T = { timeout: 20000 };

test('findSlashAbbreviations flags A/C, w/ , and/or, his/her, 24/7; does not flag https://example.com/a or plain prose', T, () => {
  assert.ok(findSlashAbbreviations('A/C').length > 0);
  assert.ok(findSlashAbbreviations('w/ ').length > 0);
  assert.ok(findSlashAbbreviations('and/or').length > 0);
  assert.ok(findSlashAbbreviations('his/her').length > 0);
  assert.ok(findSlashAbbreviations('24/7').length > 0);
  assert.equal(findSlashAbbreviations('https://example.com/a').length, 0);
  assert.equal(findSlashAbbreviations('plain prose').length, 0);
});

test('a crew script-writer script event whose narration contains "A/C" is rejected with SCRIPT_SLASH_ABBREVIATION (knownFinished); the same text with "AC" passes; a human/operator-import script with a slash is not rejected', T, async () => {
  const crew = {
    workers: Object.keys(crewRoles).map(role => ({
      workerId: `host-${role}`,
      name: crewRoles[role].name,
      role,
      modelVersion: 'inherit-current-test-host',
      capabilityVersion: 'isolated-tools-v1',
      execution: 'host'
    }))
  };
  const bind = p => send(p, 'configure-crew', { actor: 'human', message: 'bind crew', crew });

  const p = bind(initialProject('script-slash-test', inputs, { workflowRevision: 2 }));
  const task = taskFor(p);
  const worker = task.crewWorker;
  assert.equal(worker.role, 'script-writer');

  const scriptWithSlash = {
    ...script,
    beats: [
      { ...script.beats[0], narration: 'The motel had cold A/C and stayed open.' },
      ...script.beats.slice(1)
    ]
  };

  // Rejection of crew worker script event containing "A/C"
  await assert.rejects(
    runCrewTask(p, task, {
      runTask: async () => event(p, 'artifact', { workerId: worker.workerId, content: scriptWithSlash })
    }),
    e => e.knownFinished && /SCRIPT_SLASH_ABBREVIATION: beat 1: "A\/C"/.test(e.message)
  );

  // Acceptance of clean text with "AC"
  const scriptClean = {
    ...script,
    beats: [
      { ...script.beats[0], narration: 'The motel had cold AC and stayed open.' },
      ...script.beats.slice(1)
    ]
  };

  const result = await runCrewTask(p, task, {
    runTask: async () => event(p, 'artifact', { workerId: worker.workerId, content: scriptClean })
  });
  assert.equal(result.action, 'artifact');

  // Human / operator-import script with a slash is not rejected
  const humanProject = initialProject('human-slash-test', inputs, { workflowRevision: 2 });
  assert.doesNotThrow(() => applyEvent(humanProject, {
    taskId: taskFor(humanProject).taskId,
    action: 'artifact',
    actor: 'agent',
    workerId: 'operator-import',
    content: scriptWithSlash
  }));
});

test("Leo's skill file contains the no-slash rule", T, async () => {
  const leoSkill = await readFile(new URL('../crew/leo/SKILL.md', import.meta.url), 'utf8');
  assert.match(leoSkill, /no slashes/);
  assert.match(leoSkill, /A\/C/);
  assert.match(leoSkill, /air conditioning/);
  assert.match(leoSkill, /w\//);
  assert.match(leoSkill, /reads them aloud/);
});

test("Sage's skill + text rubric contain the lived-in/generic-room rule and the new evidence sources", T, async () => {
  const sageSkill = await readFile(new URL('../crew/sage/SKILL.md', import.meta.url), 'utf8');
  const textRubric = await readFile(new URL('../evaluation/rubrics/text.md', import.meta.url), 'utf8');
  const briefGuide = await readFile(new URL('../crew/sage/steps/backgroundBrief.md', import.meta.url), 'utf8');
  const promptGuide = await readFile(new URL('../crew/sage/steps/backgroundPrompt.md', import.meta.url), 'utf8');
  const angleBriefGuide = await readFile(new URL('../crew/sage/steps/backgroundAngleBrief.md', import.meta.url), 'utf8');
  const anglePromptGuide = await readFile(new URL('../crew/sage/steps/backgroundAnglePrompt.md', import.meta.url), 'utf8');

  // Lived-in set-dressing lessons now live in the per-step guides: the brief
  // guides carry lived-in/story-dressed; every background guide carries the rest.
  for (const doc of [briefGuide, angleBriefGuide]) {
    assert.match(doc, /lived-in/);
    assert.match(doc, /story-dressed/);
  }
  for (const doc of [briefGuide, promptGuide, angleBriefGuide, anglePromptGuide]) {
    assert.match(doc, /Pixar feature-film set/);
    assert.match(doc, /catalog/);
    assert.match(doc, /"plain" or "unmarked" props/);
    assert.match(doc, /rich,? saturated colour with one hero accent/); // r5 #2: never muted
    assert.doesNotMatch(doc, /muted palette with one saturated accent/);
    assert.doesNotMatch(doc, /ivory\/oatmeal\/neutral\/restrained/);
    assert.match(doc, /"blank" or "calm" walls/);
    assert.match(doc, /Empty of people/);
    assert.match(doc, /Material defects, not taste/);
  }

  // The text rubric keeps the full room rule and the evidence-source list.
  {
    const doc = textRubric;
    assert.match(doc, /lived-in/);
    assert.match(doc, /house style/);
    assert.match(doc, /story-dressed/);
    assert.match(doc, /catalog/);
    assert.match(doc, /plain\/unmarked/);
    assert.match(doc, /\[L-PALETTE\]/); // r5 #2: rich saturated palette, one hero accent; muted fails
    assert.doesNotMatch(doc, /ivory\/oatmeal\/neutral\/restrained/);
    assert.match(doc, /blank\/calm walls/);
    assert.match(doc, /empty of people/i);
    assert.match(doc, /material defect/i);

    // New evidence sources
    assert.match(doc, /task\.lockedAnswers/);
    assert.match(doc, /task\.inputs\.answers/);
    assert.match(doc, /task\.creativeDirections/);
    assert.match(doc, /task\.shotIntentions/);
    assert.match(doc, /signed production bible/i);
    assert.match(doc, /drafts never count/i);
  }

  // Sage core states the quote rule in its current wording.
  assert.match(sageSkill, /verbatim quote/);
  assert.match(sageSkill, /locked answers/);
  assert.match(sageSkill, /creative directions/);
  assert.match(sageSkill, /approved shot plan/);
  assert.match(sageSkill, /production bible/);
  assert.match(sageSkill, /Never from a draft/);
});
