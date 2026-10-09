import { initialProject, current, taskFor } from '../../runtime/workflow.mjs';
import { digest } from '../../runtime/contracts.mjs';
import { inputs, script, send, event, approved, reviewed, file, produce } from '../helpers.mjs';

export const choice = { voiceId: '00000000-0000-4000-8000-000000000002', name: 'ISOLATED reused clone', consentMessage: 'ISOLATED own-voice consent', reuseWithoutSample: true };
export const lookup = { voiceId: choice.voiceId, name: choice.name, language: 'en', isOwner: true, status: 'active', access: 'private', apiVersion: '2026-08-14', checkedAt: '2026-10-04T00:00:00Z', endpoint: `https://api.cartesia.ai/voices/${choice.voiceId}`, httpStatus: 200 };
export const draft = { ...script, commonSenseChecks: [], proposedCast: [{ id: 'alex', name: 'Alex', ageVariant: 'adult', minor: false, storyPurpose: 'ISOLATED memories' }] };
export function start(options = {}) {
  let p = initialProject('project', inputs, options);
  p = approved(reviewed(send(p, 'artifact', { workerId: 'writer', content: { inputs: p.inputs, sourceInputDigest: digest(p.inputs), commonSenseChecks: [] } })));
  return approved(reviewed(send(p, 'artifact', { workerId: 'writer', content: draft })));
}
export const choose = (p, content = choice) => send(p, 'choose-voice', { actor: 'human', message: 'ISOLATED reuse my existing clone', content });
export const verify = p => send(p, 'voice-verified', { actor: 'runtime', content: lookup });
export const ready = () => verify(choose(start()));
export function audition() {
  let p = ready();
  p = send(p, 'set-budget', { actor: 'human', message: 'ISOLATED ceiling', budgetLimitUsd: 1 });
  return produce(p, { files: [file(1)], voiceId: choice.voiceId, transcript: draft.beats[0].narration });
}
export function reviewEvent(p) {
  const a = current(p);
  return event(p, 'review', {
    workerId: 'audio-reviewer',
    artifactId: a.id,
    artifactDigest: a.digest,
    review: {
      decision: 'provisional',
      perception: 'direct-audio',
      modelVersion: 'ISOLATED-model',
      capabilityVersion: 'ISOLATED-tools',
      coverage: {
        artifactSha256: a.content.files[0].sha256,
        audioFiles: a.content.files.map(f => ({ sha256: f.sha256, seconds: f.durationSeconds }))
      },
      checks: taskFor(p).criteria.map(criterion => ({
        criterion,
        status: criterion === 'voice-match' ? 'inconclusive' : 'pass',
        evidence: criterion === 'voice-match' ? 'ISOLATED: no original recording; actual human must recognize their voice.' : 'ISOLATED mock check',
        location: 'whole fixture',
        repair: ''
      })),
      measurements: {
        identityBasis: 'human-recognition',
        transcripts: a.content.transcript ? [a.content.transcript] : a.content.transcripts,
        speechToTextMethod: 'ISOLATED mock STT',
        speakingRateWpm: a.content.files.map(() => 80),
        silenceSeconds: a.content.files.map(() => 0),
        measurementNotes: 'ISOLATED: no biometric comparison or production-quality claim.'
      }
    }
  });
}
export const passReview = p => send(p, 'review', { ...reviewEvent(p) });
export function humanApprove(p) {
  const a = current(p);
  return approved(p, {
    humanReview: {
      decision: 'approved',
      perception: 'direct-audio',
      checks: taskFor(p).criteria.map(criterion => ({
        criterion,
        status: 'pass',
        evidence: 'ISOLATED actual human recognizes own voice and approves this fixture',
        location: 'whole fixture',
        repair: ''
      }))
    }
  });
}
