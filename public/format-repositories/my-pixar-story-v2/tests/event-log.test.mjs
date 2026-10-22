import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  readEvents,
  withEventLog,
  projectState,
  rewindRun,
} from '../graph/event-log.mjs';
import { PipelineStateSchema } from '../graph/state.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'v2-event-log-'));
  return {
    root,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('appendEvent and readEvents: appends valid events and handles reads', () => {
  const { root, done } = sandbox();
  try {
    const file = join(root, 'events.jsonl');
    assert.deepEqual(readEvents(file), []);

    appendEvent(file, { agent: 'story-director', type: 'start' });
    appendEvent(file, { agent: 'story-director', type: 'attempt', attempt: 1 });
    appendEvent(file, { agent: 'story-director', type: 'passed', attempt: 1 });

    const events = readEvents(file);
    assert.equal(events.length, 3);
    assert.equal(events[0].agent, 'story-director');
    assert.equal(events[0].type, 'start');
    assert.ok(events[0].at);
    assert.equal(events[2].type, 'passed');
  } finally {
    done();
  }
});

test('withEventLog: writes to disk and calls underlying onEvent callback', () => {
  const { root, done } = sandbox();
  try {
    const file = join(root, 'events.jsonl');
    const seen = [];
    const wrapped = withEventLog(file, (e) => seen.push(e));

    wrapped({ agent: 'character-architect', type: 'start' });
    wrapped({ agent: 'character-architect', type: 'attempt', attempt: 1 });

    assert.equal(seen.length, 2);
    const disk = readEvents(file);
    assert.equal(disk.length, 2);
    assert.equal(disk[0].agent, 'character-architect');
  } finally {
    done();
  }
});

test('projectState: correctly reconstructs state and respects beforeAgent cutoff', () => {
  const mockEvents = [
    { at: '2026-10-21T20:00:00.000Z', agent: 'story-director', type: 'start' },
    { at: '2026-10-21T20:00:01.000Z', agent: 'story-director', type: 'attempt', attempt: 1 },
    { at: '2026-10-21T20:00:10.000Z', agent: 'story-director', type: 'passed', attempt: 1 },
    { at: '2026-10-21T20:00:11.000Z', agent: 'character-architect', type: 'start' },
    { at: '2026-10-21T20:00:12.000Z', agent: 'character-architect', type: 'attempt', attempt: 1 },
    {
      at: '2026-10-21T20:00:15.000Z',
      agent: 'character-architect',
      type: 'attempt-result',
      attempt: 1,
      isValid: false,
      issues: [{ severity: 'error', code: 'MISSING_OUTIFT', message: 'Outfit missing' }],
    },
    { at: '2026-10-21T20:00:16.000Z', agent: 'character-architect', type: 'attempt', attempt: 2 },
    { at: '2026-10-21T20:00:20.000Z', agent: 'character-architect', type: 'passed', attempt: 2 },
    { at: '2026-10-21T20:00:21.000Z', agent: 'storyboard-artist', type: 'start' },
    { at: '2026-10-21T20:00:22.000Z', agent: 'storyboard-artist', type: 'attempt', attempt: 1 },
  ];

  // Full projection
  const full = projectState(mockEvents);
  assert.deepEqual(full.completedAgents, ['story-director', 'character-architect']);
  assert.equal(full.attempts['character-architect'], 2);
  assert.equal(full.retryCounts['character-architect'], 1);
  assert.equal(full.validationErrors.length, 1);
  assert.equal(full.validationErrors[0].node, 'character-architect');

  // Cutoff before storyboard-artist
  const beforeSb = projectState(mockEvents, { beforeAgent: 'storyboard-artist' });
  assert.deepEqual(beforeSb.completedAgents, ['story-director', 'character-architect']);
  assert.equal(beforeSb.attempts['storyboard-artist'], undefined);

  // Cutoff before character-architect
  const beforeCa = projectState(mockEvents, { beforeAgent: 'character-architect' });
  assert.deepEqual(beforeCa.completedAgents, ['story-director']);
  assert.equal(beforeCa.attempts['character-architect'], undefined);
});

test('rewindRun: copies only upstream outputs and creates clean branched environment', () => {
  const { root, done } = sandbox();
  try {
    const srcRun = join(root, 'run-source');
    const srcOutputs = join(srcRun, 'outputs');
    const srcAssets = join(srcRun, 'assets');
    const eventsFile = join(srcRun, 'events.jsonl');

    mkdirSync(srcOutputs, { recursive: true });
    mkdirSync(srcAssets, { recursive: true });

    // Create source files
    writeFileSync(
      join(srcOutputs, 'story-director.json'),
      JSON.stringify({ title: 'Yu-Gi-Oh Duel' }, null, 2)
    );
    writeFileSync(
      join(srcOutputs, 'character-architect.json'),
      JSON.stringify({ characters: [{ name: 'Shaz' }] }, null, 2)
    );
    writeFileSync(
      join(srcOutputs, 'storyboard-artist.json'),
      JSON.stringify({ panels: [{ id: 'p1' }] }, null, 2)
    );
    writeFileSync(join(srcAssets, 'Image 1-shaz.png'), 'FAKE_IMAGE_DATA');

    // Write source event log
    appendEvent(eventsFile, { agent: 'story-director', type: 'start' });
    appendEvent(eventsFile, { agent: 'story-director', type: 'passed', attempt: 1 });
    appendEvent(eventsFile, { agent: 'character-architect', type: 'start' });
    appendEvent(eventsFile, { agent: 'character-architect', type: 'passed', attempt: 1 });
    appendEvent(eventsFile, {
      type: 'assets-approved',
      approvedAssets: { '@Image 1': 'runs/run-source/assets/Image 1-shaz.png' },
    });
    appendEvent(eventsFile, { agent: 'storyboard-artist', type: 'start' });
    appendEvent(eventsFile, { agent: 'storyboard-artist', type: 'failed', attempt: 1 });

    const newRun = join(root, 'run-rewound');
    const res = rewindRun({
      sourceRunDir: srcRun,
      targetAgent: 'storyboard-artist',
      newRunDir: newRun,
      log: () => {},
    });

    assert.equal(res.newRunDir, newRun);

    // Verify outputs in rewound run
    assert.ok(existsSync(join(newRun, 'outputs', 'story-director.json')));
    assert.ok(existsSync(join(newRun, 'outputs', 'character-architect.json')));
    // storyboard-artist output should NOT be present (it was the target to rewind to!)
    assert.ok(!existsSync(join(newRun, 'outputs', 'storyboard-artist.json')));

    // Verify assets copied
    assert.ok(existsSync(join(newRun, 'assets', 'Image 1-shaz.png')));

    // Verify state.json
    const newState = JSON.parse(readFileSync(join(newRun, 'outputs', 'state.json'), 'utf8'));
    assert.equal(newState.rewoundFrom.targetAgent, 'storyboard-artist');
    assert.ok(newState.approvedAssets['@Image 1']);

    // Verify branched events.jsonl
    const newEvents = readEvents(join(newRun, 'events.jsonl'));
    assert.ok(newEvents.length > 0);
    assert.equal(newEvents.at(-1).type, 'run-branched');
    assert.equal(newEvents.at(-1).targetAgent, 'storyboard-artist');
  } finally {
    done();
  }
});

test('projectState output validates cleanly against PipelineStateSchema', () => {
  const mockEvents = [
    { at: '2026-10-21T20:00:00.000Z', agent: 'story-director', type: 'start' },
    { at: '2026-10-21T20:00:10.000Z', agent: 'story-director', type: 'passed', attempt: 1 },
    { at: '2026-10-21T20:00:11.000Z', agent: 'location-scout', type: 'start' },
    {
      at: '2026-10-21T20:00:15.000Z',
      agent: 'location-scout',
      type: 'attempt-result',
      attempt: 1,
      isValid: false,
      issues: [{ code: 'INVALID_OPENING_STYLE', message: 'Missing house line' }],
    },
    { at: '2026-10-21T20:00:20.000Z', agent: 'location-scout', type: 'passed', attempt: 2 },
    {
      at: '2026-10-21T20:00:25.000Z',
      type: 'assets-approved',
      approvedAssets: {
        '@Image 1': 'asset:master-render:shaz',
        '@Loc 1': 'asset:location-plate:living-room',
      },
      assetFiles: {
        '@Image 1': 'runs/r6-live/assets/Image 1-shaz.png',
        'asset:master-render:shaz': 'runs/r6-live/assets/Image 1-shaz.png',
      },
    },
  ];

  const projected = projectState(mockEvents);
  const parsed = PipelineStateSchema.safeParse({ inputs: { answers: {} }, ...projected });
  assert.equal(parsed.success, true, parsed.error ? JSON.stringify(parsed.error.issues) : '');
  assert.equal(parsed.data.status, 'approved');
  assert.equal(parsed.data.approvedAssets['@Image 1'], 'asset:master-render:shaz');
  assert.equal(parsed.data.validationErrors[0].errors[0].severity, 'error');
});
