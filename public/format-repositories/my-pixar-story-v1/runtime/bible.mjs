// Frozen production bible: ONE locked brief (script, cast, style, scene digest) that the
// human signs once and every crew agent reads, so characters and scenes do not drift
// between departments.
//
// States: a version is created as `draft`; only a human `bible-sign` event (runner
// `bible-sign`, interactive terminal) turns it into `signed`. A signed version is frozen:
// any change is a NEW draft version that needs signing again. Agents can never sign.
// Policy: `required` (new runs) makes departments after the script/cast stage wait for a
// signed bible; `advisory` lets them run with a loud warning. Projects without a bible
// field are historical and keep their compatible path (no bible in packets).
import { z } from 'zod';
import { text, digest } from './contracts.mjs';
import { current, locked, sheetKeyFor } from './gates.mjs';

export const BIBLE_SCHEMA = 'wiggly-production-bible/v1';
export const UNRESOLVED = 'UNRESOLVED';
// Departments after the script/cast stage. They consume the bible; everything before it
// (answers, script, voice, roster, character sheets) is the material the bible is drafted from.
export const BIBLE_DOWNSTREAM_STEPS = ['shotIntentions', 'backgrounds', 'backgroundBrief', 'backgroundPrompt', 'backgroundCandidates', 'backgroundAngleBrief', 'backgroundAnglePrompt', 'backgroundAngle', 'shots', 'keyframePrompt', 'keyframe', 'reviewerQualification', 'videoPlan', 'videoPrompt', 'video', 'soundPlan', 'music', 'effect', 'editPlan', 'film'];
const SECTIONS = ['logline', 'script', 'cast', 'style', 'scenes'];
// What each role reads. Reviewers get every section their deliverable can contradict.
export const BIBLE_SLICES = {
  'script-writer': ['logline', 'script', 'cast', 'style', 'scenes'],
  'text-reviewer': SECTIONS,
  'cast-designer': ['logline', 'cast', 'style'],
  'sheet-prompter': ['cast', 'style'],
  'visual-reviewer': ['cast', 'style', 'scenes'],
  'background-product-owner': ['logline', 'cast', 'style', 'scenes'],
  'pixar-prompter': ['cast', 'style', 'scenes'],
  'shot-planner': SECTIONS,
  'composition-writer': ['cast', 'style', 'scenes'],
  'scene-reviewer': ['script', 'cast', 'style', 'scenes'],
  'motion-director': ['cast', 'style', 'scenes'],
  'video-prompt-engineer': ['cast', 'style', 'scenes'],
  'sound-designer': ['logline', 'script', 'scenes'],
  'film-editor': ['logline', 'script', 'scenes'],
  'voice-director': ['script'],
  'audio-reviewer': ['script'],
  'generation-planner': ['style'],
  orchestrator: SECTIONS,
};
export const BIBLE_REVIEWER_ROLES = ['text-reviewer', 'visual-reviewer', 'scene-reviewer'];

const Ref = z.object({ artifactId: text, digest: text }).strict();
const Beat = z.object({ beat: z.number().int().min(1).max(4), narration: text, purpose: text.optional() }).strict();
const CastMember = z.object({
  id: text, name: text, ageVariant: text, minor: z.boolean(), storyPurpose: text,
  sheet: z.object({ artifactId: text, digest: text, selection: z.number().int().min(0), sha256: text.optional(), pick: text }).strict().nullable(),
  lockedDescription: text,
  continuity: z.array(text).min(1),
  referencePhoto: z.object({ status: z.enum(['reference-photo', 'interpreted-no-photo', 'photo-outside-pipeline', 'missing']), note: text }).strict(),
}).strict();
const Scene = z.object({
  id: text, beat: z.number().int().min(1).max(4), location: text, locationId: text.optional(), characterIds: z.array(text),
  timeOfDay: text, mood: text, keyProps: z.array(text), setDressing: z.array(text), notes: z.array(text).default([]),
}).strict();
export const BibleContent = z.object({
  schema: z.literal(BIBLE_SCHEMA),
  title: text,
  logline: text,
  script: z.object({ source: Ref.nullable(), lockedPointer: text, beats: z.array(Beat).min(1).max(4), notes: z.array(text).default([]) }).strict(),
  cast: z.array(CastMember).min(1),
  style: z.object({ look: text, sets: text, rules: z.array(text).min(1) }).strict(),
  scenes: z.array(Scene).min(1),
  openQuestions: z.array(text).default([]),
}).strict().superRefine((b, ctx) => {
  const ids = b.cast.map(c => c.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Cast ids must be unique.' });
  const sceneIds = b.scenes.map(s => s.id);
  if (new Set(sceneIds).size !== sceneIds.length) ctx.addIssue({ code: 'custom', message: 'Scene ids must be unique.' });
  for (const s of b.scenes) for (const id of s.characterIds) if (!ids.includes(id)) ctx.addIssue({ code: 'custom', message: `Scene ${s.id} names unknown cast member ${id}.` });
});
export const BibleEntry = z.object({
  version: z.number().int().positive(), hash: text, state: z.enum(['draft', 'signed']), content: BibleContent,
  createdAt: text, createdBy: z.object({ actor: text, message: text }).strict(),
  signature: z.object({ by: text, message: text, at: text }).strict().optional(),
}).strict();
export const ProjectBible = z.object({ policy: z.enum(['required', 'advisory']), versions: z.array(BibleEntry) }).strict();

export const bibleHash = content => digest(BibleContent.parse(content));
export function parseBible(content) {
  const parsed = BibleContent.parse(content);
  return { content: parsed, hash: digest(parsed), unresolved: unresolvedPaths(parsed) };
}
export function unresolvedPaths(value, path = '') {
  if (typeof value === 'string') return value.includes(UNRESOLVED) ? [path || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => unresolvedPaths(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => unresolvedPaths(v, path ? `${path}.${k}` : k));
  return [];
}
export const latestBible = p => p.bible?.versions.at(-1) ?? null;
export const signedBible = p => p.bible?.versions.findLast(v => v.state === 'signed') ?? null;
export const bibleWaiting = p => p.bible?.policy === 'required' && BIBLE_DOWNSTREAM_STEPS.includes(p.step) && !signedBible(p);
export function assertBibleReady(p) {
  if (!bibleWaiting(p)) return;
  const draft = latestBible(p);
  throw new Error(`BIBLE_NOT_SIGNED: ${p.step} is after the script/cast stage and this run requires a signed production bible. ${draft ? `Draft v${draft.version} (${draft.hash.slice(0, 12)}) is waiting for the human to review (bible-render) and sign (bible-sign).` : 'Draft it first with bible-draft once every character sheet is locked.'} No agent may sign it.`);
}
// Valid downstream work authored against no signed bible or an older signed version.
export function staleAgainstBible(p) {
  const signed = signedBible(p);
  if (!signed) return [];
  return p.artifacts.filter(a => a.valid && BIBLE_DOWNSTREAM_STEPS.includes(a.kind) && a.bible?.hash !== signed.hash)
    .map(a => ({ artifactId: a.id, kind: a.kind, bibleVersion: a.bible?.version ?? null, reason: a.bible ? `made against signed v${a.bible.version}; current signed is v${signed.version}` : 'made before any signed bible' }));
}
export const bibleStamp = p => { const s = signedBible(p); return s ? { version: s.version, hash: s.hash } : null; };
export function bibleSummary(p, runDir = '<run>') {
  if (!p.bible) return null;
  const latest = latestBible(p), signed = signedBible(p), stale = staleAgainstBible(p), waiting = bibleWaiting(p);
  const pendingDraft = latest && latest.state === 'draft' ? { version: latest.version, hash: latest.hash } : null;
  let message;
  if (waiting) message = latest ? `Waiting for the human to sign production bible v${latest.version} before ${p.step}. Review: node runner.mjs bible-render --run ${runDir}. Sign (human, in Terminal): node runner.mjs bible-sign --run ${runDir} --by <name> --hash ${latest.hash.slice(0, 12)}` : `Waiting for a production bible before ${p.step}: draft it with node runner.mjs bible-draft --run ${runDir} --message "<instruction>" [--file bible.json], then the human reviews and signs.`;
  else if (!signed && BIBLE_DOWNSTREAM_STEPS.includes(p.step)) message = 'WARNING: no signed production bible; downstream work is running without the locked brief (advisory policy).';
  else if (pendingDraft && signed) message = `Production bible v${pendingDraft.version} is a draft awaiting signature; work continues against signed v${signed.version}.`;
  return { policy: p.bible.policy, versions: p.bible.versions.length, signed: signed ? { version: signed.version, hash: signed.hash, by: signed.signature.by, at: signed.signature.at } : null, pendingDraft, waiting, staleArtifacts: stale, ...(message ? { message } : {}) };
}

const AUTHOR_INSTRUCTION = 'This is the SIGNED production bible: the single locked brief for story, cast, wardrobe/prop continuity, style and scenes. Follow it exactly and never contradict it. If newer human feedback in this task conflicts with it, follow the human feedback and state the conflict in your notes so the bible gets a new version.';
const REVIEW_INSTRUCTION = 'Check the deliverable against this SIGNED production bible as well as your rubric. Any contradiction of a locked cast description, a wardrobe/prop continuity fact, a style rule or the scene digest (location, who is in it, time of day, mood, key story props, set dressing) fails the most relevant criterion; quote the exact bible line as evidence. The signed bible is a locked source, so its wording is valid quote evidence. Do not fail a deliverable for details the bible does not specify.';
// The role's slice of the bible for a task packet. Undefined for historical projects so
// their packets stay byte-identical.
export function biblePacket(p, role, gate, artifact) {
  if (!p.bible) return undefined;
  const signed = signedBible(p), latest = latestBible(p);
  if (!signed) {
    if (!BIBLE_DOWNSTREAM_STEPS.includes(p.step)) return undefined;
    return { status: 'unsigned', blocking: p.bible.policy === 'required', warning: `NO SIGNED PRODUCTION BIBLE${latest ? ` (draft v${latest.version} is unsigned)` : ''}. Characters, wardrobe and scenes are not locked by a signed brief; use only the locked artifacts in this task and flag any continuity guess.` };
  }
  const keys = BIBLE_SLICES[role] ?? SECTIONS;
  const sections = Object.fromEntries(keys.map(k => [k, signed.content[k]]));
  const reviewing = ['review', 'owner-review'].includes(gate) && (BIBLE_REVIEWER_ROLES.includes(role) || gate === 'owner-review');
  const staleArtifact = reviewing && artifact && BIBLE_DOWNSTREAM_STEPS.includes(artifact.kind) && artifact.bible?.hash !== signed.hash;
  return {
    status: 'signed', version: signed.version, hash: signed.hash, signedBy: signed.signature.by, signedAt: signed.signature.at, sections,
    instruction: reviewing ? REVIEW_INSTRUCTION : AUTHOR_INSTRUCTION,
    ...(latest !== signed ? { note: `Draft v${latest.version} is unsigned; it is NOT in force. Work against signed v${signed.version}.` } : {}),
    ...(staleArtifact ? { staleWarning: `This deliverable was made ${artifact.bible ? `against signed v${artifact.bible.version}` : 'without a signed bible'}; check it against signed v${signed.version}.` } : {}),
  };
}

// A draft compiled from the project's locked material. Creative summaries that cannot be
// derived mechanically are marked UNRESOLVED; signing refuses until they are written.
export const DEFAULT_STYLE = {
  look: 'Pixar-style 3D animated feature film: appealing sculpted forms, expressive faces, warm cinematic lighting; never photoreal.',
  sets: 'Real Pixar feature-film sets: lived-in and story-dressed so each place is obviously this character\'s world. Never empty, generic, muted rooms.',
  rules: ['No text, letters, numbers, logos or signage anywhere in images.', 'Characters are composited later: background plates contain zero people.', 'Every character keeps the exact locked sheet design, wardrobe and props in every shot.'],
};
export function compileBible(p) {
  const script = current(p, 'script'), roster = current(p, 'roster');
  const plan = current(p, 'shotIntentions') ?? current(p, 'backgrounds');
  const cast = (roster?.content.characters ?? script?.content.proposedCast ?? []).map(c => {
    const proposed = script?.content.proposedCast?.find(x => x.id === c.id);
    const sheet = current(p, sheetKeyFor(p, c.id)), intake = roster?.intakeConfirmation?.characters?.find(x => x.id === c.id);
    const selection = sheet?.selection ?? 0, file = sheet?.content.files?.[selection];
    return { id: c.id, name: c.name, ageVariant: c.ageVariant, minor: proposed?.minor ?? intake?.minor ?? false, storyPurpose: proposed?.storyPurpose ?? c.notes ?? UNRESOLVED,
      sheet: sheet && locked(p, sheet.key) ? { artifactId: sheet.id, digest: sheet.digest, selection, ...(file?.sha256 ? { sha256: file.sha256 } : {}), pick: sheet.approvedBy?.message ?? UNRESOLVED } : null,
      lockedDescription: `${UNRESOLVED}: summarize the locked sheet design`, continuity: [`${UNRESOLVED}: wardrobe/prop continuity facts`],
      referencePhoto: intake?.likeness === 'reference' ? { status: 'reference-photo', note: `${(intake.references ?? []).length} reference photo(s) bound in the roster.` } : intake?.likeness === 'interpreted' ? { status: 'interpreted-no-photo', note: intake.decisionNotes ?? 'Interpreted likeness.' } : { status: 'missing', note: UNRESOLVED } };
  });
  const scenes = (plan?.content.locations ?? []).flatMap(l => l.scenes.map(s => ({ id: s.id, beat: s.beat ?? 1, location: l.name, locationId: l.id, characterIds: s.characterIds ?? [], timeOfDay: UNRESOLVED, mood: UNRESOLVED, keyProps: [], setDressing: [], notes: [s.description].filter(Boolean) })));
  return {
    schema: BIBLE_SCHEMA, title: `${p.inputs?.subject?.preferredName ?? p.id} production bible`, logline: `${UNRESOLVED}: one-line logline`,
    script: { source: script ? { artifactId: script.id, digest: script.digest } : null, lockedPointer: script ? `${script.id} (locked script in this run)` : UNRESOLVED,
      beats: (script?.content.beats ?? [{ beat: 1, narration: UNRESOLVED }]).map(b => ({ beat: b.beat, narration: b.narration, ...(b.emotionalPurpose ? { purpose: b.emotionalPurpose } : {}) })), notes: [] },
    cast: cast.length ? cast : [{ id: UNRESOLVED, name: UNRESOLVED, ageVariant: UNRESOLVED, minor: false, storyPurpose: UNRESOLVED, sheet: null, lockedDescription: UNRESOLVED, continuity: [UNRESOLVED], referencePhoto: { status: 'missing', note: UNRESOLVED } }],
    style: DEFAULT_STYLE,
    scenes: scenes.length ? scenes : [{ id: UNRESOLVED, beat: 1, location: UNRESOLVED, characterIds: [], timeOfDay: UNRESOLVED, mood: UNRESOLVED, keyProps: [], setDressing: [], notes: [] }],
    openQuestions: [],
  };
}

// Sources a bible names must be real artifacts of this run; at signing they must be the
// CURRENT LOCKED versions, and every locked roster character must have a locked sheet pick.
function checkSources(p, content, { forSigning }) {
  const problems = [];
  const check = (key, ref, label) => {
    const a = p.artifacts.find(x => x.id === ref.artifactId);
    if (!a || a.digest !== ref.digest) { problems.push(`${label}: ${ref.artifactId} is not an artifact of this run with that digest`); return; }
    if (forSigning && (current(p, key)?.id !== a.id || !locked(p, key))) problems.push(`${label}: ${ref.artifactId} is not the current locked ${key}`);
  };
  if (content.script.source) check('script', content.script.source, 'script');
  else if (forSigning) problems.push('script: no locked script bound');
  for (const c of content.cast) {
    if (c.sheet) check(sheetKeyFor(p, c.id), c.sheet, `cast ${c.id}`);
    else if (forSigning) problems.push(`cast ${c.id}: no locked sheet pick bound`);
  }
  if (forSigning) for (const c of current(p, 'roster')?.content.characters ?? []) if (!content.cast.some(x => x.id === c.id)) problems.push(`cast ${c.id}: roster character missing from the bible`);
  return problems;
}
export function applyBibleEvent(p, e) {
  if (e.actor !== 'human') throw new Error(`${e.action} requires human authority; agents can never draft-over or sign the production bible.`);
  if (!e.message) throw new Error(`${e.action} needs the actual human instruction.`);
  const at = new Date().toISOString();
  if (e.action === 'bible-draft') {
    const { content, hash } = parseBible(e.content ?? compileBible(p));
    const problems = checkSources(p, content, { forSigning: false });
    if (problems.length) throw new Error(`BIBLE_SOURCE_INVALID: ${problems.join('; ')}`);
    p.bible ??= { policy: 'advisory', versions: [] };
    const latest = latestBible(p);
    if (latest?.hash === hash) throw new Error(`BIBLE_UNCHANGED: v${latest.version} already has this exact content (${hash.slice(0, 12)}).`);
    p.bible.versions.push({ version: (latest?.version ?? 0) + 1, hash, state: 'draft', content, createdAt: at, createdBy: { actor: e.actor, message: e.message } });
    return;
  }
  // bible-sign: binds the exact draft content the human reviewed.
  const by = e.content?.by;
  if (typeof by !== 'string' || !by.trim()) throw new Error('BIBLE_SIGNER_REQUIRED: name the human signing (--by).');
  const latest = latestBible(p);
  if (!latest) throw new Error('BIBLE_MISSING: draft the production bible first.');
  if (latest.state !== 'draft') throw new Error(`BIBLE_ALREADY_SIGNED: v${latest.version} is signed and frozen; any change needs a new draft.`);
  if (e.artifactDigest !== latest.hash) throw new Error(`BIBLE_HASH_MISMATCH: the reviewed hash does not match draft v${latest.version} (${latest.hash.slice(0, 12)}). Re-render and review the current draft.`);
  const { unresolved } = parseBible(latest.content);
  if (latest.content.openQuestions.length) throw new Error(`BIBLE_OPEN_QUESTIONS: ${latest.content.openQuestions.length} open question(s) remain; answer them in a new draft before signing.`);
  if (unresolved.length) throw new Error(`BIBLE_UNRESOLVED: ${unresolved.join(', ')}`);
  const problems = checkSources(p, latest.content, { forSigning: true });
  if (problems.length) throw new Error(`BIBLE_SOURCE_NOT_LOCKED: ${problems.join('; ')}`);
  latest.state = 'signed';
  latest.signature = { by: by.trim(), message: e.message, at };
}

const list = items => items.map(x => `- ${x}`).join('\n');
export function renderBibleMarkdown(entry, { runDir = null, superseded = false } = {}) {
  const b = BibleContent.parse(entry.content), hash = entry.hash ?? digest(b), unresolved = unresolvedPaths(b);
  const signed = entry.state === 'signed';
  const out = [];
  out.push(`# ${b.title}`, '');
  out.push(signed ? `> **SIGNED** v${entry.version} by ${entry.signature.by} at ${entry.signature.at}${superseded ? ' (superseded by a newer signed version)' : ''}. Frozen: any change needs a new draft and a new signature.` : `> **UNSIGNED DRAFT${entry.version ? ` v${entry.version}` : ''}. NOT IN FORCE.** Only the human signs this. No agent may sign it.`);
  out.push('', `Content hash: \`${hash}\``, '');
  if (b.openQuestions.length || unresolved.length) {
    out.push('## Questions for you before signing', '');
    b.openQuestions.forEach((q, i) => out.push(`${i + 1}. ${q}`));
    if (unresolved.length) out.push('', `Unresolved fields: ${unresolved.join(', ')}`);
    out.push('');
  }
  out.push('## Logline', '', b.logline, '');
  out.push('## Script (locked)', '', `Locked version: ${b.script.lockedPointer}${b.script.source ? ` (digest \`${b.script.source.digest.slice(0, 12)}\`)` : ''}`, '');
  for (const beat of b.script.beats) out.push(`**Beat ${beat.beat}.** ${beat.narration}${beat.purpose ? `  \n_Purpose: ${beat.purpose}_` : ''}`, '');
  if (b.script.notes.length) out.push(list(b.script.notes), '');
  out.push('## Cast', '');
  for (const c of b.cast) {
    out.push(`### ${c.name} (\`${c.id}\`, ${c.ageVariant}${c.minor ? ', minor' : ''})`, '', c.storyPurpose, '');
    out.push(`- **Locked sheet:** ${c.sheet ? `${c.sheet.artifactId}, selection ${c.sheet.selection}${c.sheet.sha256 ? `, image \`${c.sheet.sha256.slice(0, 10)}\`` : ''}. Pick: ${c.sheet.pick}` : 'none bound'}`);
    out.push(`- **Reference photo:** ${c.referencePhoto.status}. ${c.referencePhoto.note}`);
    out.push(`- **Locked description:** ${c.lockedDescription}`);
    out.push('- **Continuity (every shot):**', ...c.continuity.map(x => `  - ${x}`), '');
  }
  out.push('## Style', '', `**Look:** ${b.style.look}`, '', `**Sets:** ${b.style.sets}`, '', list(b.style.rules), '');
  out.push('## Scene digest', '');
  for (const s of b.scenes) {
    out.push(`### Beat ${s.beat}: ${s.location} (\`${s.id}\`)`, '');
    out.push(`- **Who:** ${s.characterIds.map(id => b.cast.find(c => c.id === id)?.name ? `${b.cast.find(c => c.id === id).name} (${id})` : id).join(', ') || 'nobody on screen'}`);
    out.push(`- **Time of day:** ${s.timeOfDay}`, `- **Mood:** ${s.mood}`);
    if (s.keyProps.length) out.push(`- **Key story props:** ${s.keyProps.join('; ')}`);
    if (s.setDressing.length) out.push(`- **Set dressing:** ${s.setDressing.join('; ')}`);
    for (const n of s.notes) out.push(`- ${n}`);
    out.push('');
  }
  if (!signed) {
    out.push('## How to sign', '');
    if (b.openQuestions.length || unresolved.length) out.push('Not signable yet. Answer the questions above first; the operator records your answers as a new draft (bible-draft --file), which gets a new hash and a sign command.', '');
    else out.push('When you are happy with every section above, sign it yourself in Terminal (it asks you to type the hash back):', '', '```', `node runner.mjs bible-sign --run ${runDir ?? '<run>'} --by <your name> --hash ${hash.slice(0, 12)}`, '```', '');
  }
  return out.join('\n');
}
