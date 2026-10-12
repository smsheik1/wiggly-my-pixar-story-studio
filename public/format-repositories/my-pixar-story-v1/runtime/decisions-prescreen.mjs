import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readOpenRouterKey } from './openrouter-host.mjs';
import { paidJobTimer } from './tracing.mjs';

const exec = promisify(execFile);

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

export const DECISION_MODELS = {
  'openai/gpt-6-luna-decisions': {
    maxImages: 128,
    maxImageBytes: Infinity,
    maxTextTokens: 1050000,
    inputUsdPerM: 0.10,
    outputUsdPerM: 0,
  },
  'cloudflare/clef-flash': {
    maxImages: 4,
    maxImageBytes: 300 * 1024,
    maxTextTokens: 2000,
    inputUsdPerM: 0.038,
    outputUsdPerM: 0,
  },
};

export const PRESCREEN_QUESTIONS = {
  'no-text': {
    type: 'noul',
    instructions: 'Is this image free of baked-in text? Count only actual letters, numbers, words, labels, captions, logos, watermarks or UI. Panel borders, grid lines, gutters, blank cells and plain backdrops are NOT text.',
    criteria: {
      true: 'No letters, numbers, words, labels, captions, logos, watermarks or UI anywhere (grid lines and blank backdrops do not count)',
      false: 'Readable or pseudo letters, numbers, words, labels, captions, logos, watermarks or UI are rendered somewhere in the image',
    },
  },
  'style': {
    type: 'noul',
    instructions: 'Is this image rendered in a stylized 3D animated-feature look, and not photoreal and not 2D?',
    criteria: {
      true: 'Stylized 3D animated-feature rendering with appealing shapes, soft lighting and caricatured proportions',
      false: 'Photoreal, photographic skin/textures, uncanny-valley realism, 2D drawing, sketch or flat style',
    },
  },
  'anatomy': {
    type: 'noul',
    instructions: 'Is every figure free of visible deformities: correct hands with five fingers each, no extra, missing or fused fingers or limbs, natural joints, and no melted, duplicated or distorted faces?',
    criteria: {
      true: 'Hands, fingers, limbs and faces are all well-formed with no extra, missing, fused or distorted parts',
      false: 'A visible deformity: extra, missing or fused fingers, malformed hands or limbs, broken joints, or a melted, duplicated or distorted face',
    },
  },
  'brief-fit': {
    type: 'noul',
    instructions: 'Does the image follow the BRIEF text above: the described outfit, accessories, head covering or headscarf, hairstyle, colors, sheet layout and required views or expressions, props and setting? Judge only whether the written instructions are followed.',
    criteria: {
      true: 'Everything the brief asks for is visibly present and nothing it forbids appears (outfit, accessories, head covering, layout, views, expressions, setting)',
      false: 'Something the brief asks for is missing or wrong, or something it forbids appears (wrong outfit or colors, missing accessory or head covering, wrong layout, missing views or expressions)',
    },
  },
  'consistency': {
    type: 'noul',
    instructions: 'Does the character have a consistent outfit, hair and appearance across all views?',
    criteria: {
      true: 'Identical clothing, hairstyle, colors and accessories across all views',
      false: 'Inconsistent outfit details, changing hair, or mismatched appearance across views',
    },
  },
  'turnaround': {
    type: 'noul',
    instructions: 'Does the sheet cleanly present front, three-quarter, profile and back views in an aligned model turnaround?',
    criteria: {
      true: 'Clean model turnaround showing all required character angles in good alignment',
      false: 'Missing angles, misaligned poses or chaotic layout without clear turnaround views',
    },
  },
  'expressions': {
    type: 'noul',
    instructions: 'Are all character facial expressions distinct, readable, lively and on-model?',
    criteria: {
      true: 'Clear, appealing, varied emotional expressions that match the character personality',
      false: 'Muddied, repetitive, flat or out-of-character facial expressions',
    },
  },
  'empty-environment': {
    type: 'noul',
    instructions: 'Are there no people or characters anywhere in the frame?',
    criteria: {
      true: 'Completely free of any people, characters, figures, silhouettes or human occupants',
      false: 'Contains a person, character, figure or silhouette in the scene',
    },
  },
  'story-specific-set': {
    type: 'noul',
    instructions: 'Are the story props from the brief visibly present and does the room read as lived-in and densely dressed?',
    criteria: {
      true: 'Densely dressed, lived-in environment featuring the specific story props, era details and character hobbies',
      false: 'Generic, sparse, catalog-like showroom or missing key story-specific set pieces',
    },
  },
  'scene-fit': {
    type: 'noul',
    instructions: 'Does the environment or image match the described scene location, era, mood and storytelling context?',
    criteria: {
      true: 'Faithfully represents the scene setting, atmosphere and narrative requirements',
      false: 'Mismatch with the intended scene setting, wrong era or inappropriate mood',
    },
  },
  'spatial-action': {
    type: 'noul',
    instructions: 'Is there clear staging and open floor space suitable for character blocking and action?',
    criteria: {
      true: 'Well-structured depth, clear foreground/midground and usable staging space for character action',
      false: 'Cramped, obstructed, confusing spatial layout or impossible camera placement',
    },
  },
  'continuity': {
    type: 'noul',
    instructions: 'Does this plate maintain environmental and architectural continuity with the master set and story details?',
    criteria: {
      true: 'Consistent architecture, window placements, lighting direction and prop locations',
      false: 'Contradicts master room geometry, mismatched walls or floating/relocated architectural features',
    },
  },
  'staging': {
    type: 'noul',
    instructions: 'Is the shot staging clear, readable, cinematic and focused on the key emotional action?',
    criteria: {
      true: 'Cinematic staging with clear visual hierarchy guiding attention to the emotional core',
      false: 'Confusing visual focus, awkward tangents or poor character placement',
    },
  },
  'composition': {
    type: 'noul',
    instructions: 'Is the image framing, rule-of-thirds balance, depth and cinematic composition strong and appealing?',
    criteria: {
      true: 'Harmonious composition with strong framing, depth layers and balanced visual weight',
      false: 'Awkward cropping, tilted horizon, unbalanced negative space or flat framing',
    },
  },
  'setting-continuity': {
    type: 'noul',
    instructions: 'Does the keyframe environment match the approved location master plates and props?',
    criteria: {
      true: 'Environment perfectly matches the approved location plates, props and atmosphere',
      false: 'Noticeable differences in background architecture, lighting or props from approved plates',
    },
  },
};

// Likeness is Vera's job, never the prescreen's: no reference photos are ever sent, no
// question may ask about resemblance or identity, and likeness-related sentences are
// scrubbed out of the brief. Criteria that need a reference image to judge (continuity
// with an approved master plate) are dropped for the same reason.
export const PRESCREEN_EXCLUDED_CRITERIA = ['likeness', 'continuity', 'setting-continuity'];
export const PRESCREEN_ALWAYS_CRITERIA = ['anatomy', 'brief-fit', 'no-text'];
export const LIKENESS_TERMS = /\b(likeness|resembl\w*|look(?:s|ing)? like|reference (?:photo|image|picture)s?|photo(?:graph)?s?|photographic likeness|real person|identity|recogni[sz]\w*)\b/i;

export function prescreenCriteria(criteria = []) {
  const out = [];
  for (const c of [...criteria, ...PRESCREEN_ALWAYS_CRITERIA]) {
    if (!PRESCREEN_EXCLUDED_CRITERIA.includes(c) && !out.includes(c)) out.push(c);
  }
  return out;
}

// Drop every sentence that mentions likeness, photos or identity; keep the rest of the brief.
export function scrubLikeness(text = '') {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(sentence => sentence.trim() && !LIKENESS_TERMS.test(sentence))
    .join(' ')
    .trim();
}

// The brief a prescreen checks against: the exact generation prompt of the artifact,
// else (rooms) the background brief text. Always likeness-scrubbed.
export function prescreenBrief(project, artifact) {
  const prompt = artifact?.content?.prompt;
  let text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) {
    const [kind, id] = String(artifact?.key ?? '').split(':');
    if (kind === 'backgroundCandidates' || kind === 'backgroundAngle') {
      const arts = project?.artifacts ?? [];
      const b = (arts.findLast(a => a.key === `backgroundBrief:${id}` && a.valid) ?? arts.findLast(a => a.key === `backgroundBrief:${id}`))?.content ?? {};
      const known = Array.isArray(b.knownDetails) ? b.knownDetails.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join('; ') : '';
      text = [b.direction ?? '', known ? `Known details: ${known}` : ''].filter(Boolean).join('\n');
    }
  }
  return scrubLikeness(text).slice(0, 6000);
}

// Guard on every outgoing request: images are only the options, no REFERENCE parts, and
// no question or context mentions likeness.
export function assertNoLikeness(body, optionCount) {
  const images = body.state.filter(p => typeof p === 'object' && p?.type === 'image_url').length;
  if (images > optionCount) throw new Error(`PRESCREEN_LIKENESS_FORBIDDEN: ${images} images for ${optionCount} options (reference photos are never sent).`);
  for (const part of body.state) {
    if (typeof part === 'string' && (/^REFERENCE\b/i.test(part) || LIKENESS_TERMS.test(part))) throw new Error('PRESCREEN_LIKENESS_FORBIDDEN: likeness/reference text in the request.');
  }
  for (const [key, q] of Object.entries(body.questions ?? {})) {
    if (LIKENESS_TERMS.test(key) || LIKENESS_TERMS.test(JSON.stringify(q))) throw new Error(`PRESCREEN_LIKENESS_FORBIDDEN: question ${key} asks about likeness.`);
  }
  return body;
}

/**
 * Recompress an image buffer to <= 300KB using ffmpeg into a temp dir.
 */
export async function recompressImageToLimit(filePath, maxBytes = 300 * 1024) {
  const buf = await readFile(filePath);
  if (buf.length <= maxBytes) {
    const ext = extname(filePath).slice(1).replace('jpg', 'jpeg').toLowerCase();
    return {
      bytes: buf,
      mime: `image/${ext}`,
      base64: buf.toString('base64'),
    };
  }

  const tmp = await mkdtemp(join(tmpdir(), 'clef-recompress-'));
  try {
    let q = 85;
    let outPath = join(tmp, 'out.jpg');
    // First attempt: scale longest side to <= 1024 and compress JPEG q=85
    await exec('ffmpeg', [
      '-v', 'error', '-y',
      '-i', filePath,
      '-vf', "scale='if(gt(iw,ih),min(1024,iw),-1)':'if(gt(ih,iw),min(1024,ih),-1)'",
      '-q:v', '5',
      outPath,
    ]);

    let compressed = await readFile(outPath);
    let step = 0;
    while (compressed.length > maxBytes && step < 5) {
      step++;
      const qVal = 5 + step * 3; // higher q:v means lower quality in ffmpeg mjpeg
      await exec('ffmpeg', [
        '-v', 'error', '-y',
        '-i', filePath,
        '-vf', "scale='if(gt(iw,ih),min(800,iw),-1)':'if(gt(ih,iw),min(800,ih),-1)'",
        '-q:v', String(qVal),
        outPath,
      ]);
      compressed = await readFile(outPath);
    }

    return {
      bytes: compressed,
      mime: 'image/jpeg',
      base64: compressed.toString('base64'),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export function estimatePrescreenCost({ model, files = [], contextText = '' }) {
  const modelInfo = DECISION_MODELS[model];
  if (!modelInfo) return 0.002;

  const totalImages = files.length; // reference photos are never sent
  // Estimate ~1600 tokens per image (roughly 4 base64 chars per token)
  const imageTokens = totalImages * 1600;
  const textTokens = Math.ceil(contextText.length / 4);
  const totalInputTokens = imageTokens + textTokens + 1000; // plus instructions

  return (totalInputTokens / 1_000_000) * modelInfo.inputUsdPerM;
}

export function buildQuestionsForOption(optionIdx, criteriaList) {
  const questions = {};
  const allCriteria = prescreenCriteria(criteriaList);

  for (const criterion of allCriteria) {
    const qDef = PRESCREEN_QUESTIONS[criterion];
    if (qDef) {
      questions[`opt${optionIdx}__${criterion}`] = {
        type: 'noul',
        instructions: `OPTION ${optionIdx}: ${qDef.instructions}`,
        criteria: qDef.criteria,
      };
    } else {
      questions[`opt${optionIdx}__${criterion}`] = {
        type: 'noul',
        instructions: `OPTION ${optionIdx}: Does the image satisfy criterion '${criterion}'?`,
        criteria: {
          true: `Condition '${criterion}' is satisfied`,
          false: `Condition '${criterion}' is not satisfied`,
        },
      };
    }
  }

  return questions;
}

export async function buildRequests({
  model,
  step,
  files,
  contextText = '',
  criteria = [],
}) {
  // Any `references` a caller still passes are ignored on purpose: never sent.
  const requests = await planRequests({ model, step, files, contextText: scrubLikeness(contextText), criteria });
  for (const r of requests) assertNoLikeness(r.body, files.length);
  return requests;
}

const RANK_QUESTION = {
  type: 'choice',
  instructions: 'Which option best follows the BRIEF with no deformities and no baked-in text?',
  criteria: { '0': 'OPTION 0', '1': 'OPTION 1', '2': 'OPTION 2' },
};
const briefText = (contextText) => contextText ? `BRIEF (the instructions this image was generated from): ${contextText}` : '';

async function planRequests({ model, step, files, contextText, criteria }) {
  const modelInfo = DECISION_MODELS[model];
  if (!modelInfo) {
    throw new Error(`PRESCREEN_MODEL_UNKNOWN: add it to DECISION_MODELS with its documented limits`);
  }

  if (model === 'openai/gpt-6-luna-decisions') {
    const totalImages = files.length;
    if (totalImages > modelInfo.maxImages) {
      throw new Error(`PRESCREEN_TOO_MANY_IMAGES: ${totalImages} exceeds ${modelInfo.maxImages}`);
    }

    const state = [];
    if (contextText) {
      state.push(briefText(contextText));
    }

    for (let i = 0; i < files.length; i++) {
      state.push(`OPTION ${i}`);
      const f = files[i];
      const buf = await readFile(f.path);
      const ext = extname(f.path).slice(1).replace('jpg', 'jpeg').toLowerCase();
      state.push({
        type: 'image_url',
        image_url: { url: `data:image/${ext};base64,${buf.toString('base64')}` },
      });
    }

    const questions = {};
    for (let i = 0; i < files.length; i++) {
      Object.assign(questions, buildQuestionsForOption(i, criteria));
    }

    if (files.length === 3) {
      questions['rank'] = RANK_QUESTION;
    }

    return [{ body: { model, state, questions }, optionIndices: files.map((_, i) => i), isRank: files.length === 3 }];
  }

  if (model === 'cloudflare/clef-flash') {
    // clef-flash: <=4 images per request, ~2K text tokens read.
    // One request per option holding only that option (no reference photos).
    if (files.length > 4) {
      throw new Error(`PRESCREEN_TOO_MANY_IMAGES: clef-flash supports at most 4 images per request`);
    }
    const requests = [];
    const trimmedContext = contextText ? contextText.slice(0, 6000) : '';

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const recFile = await recompressImageToLimit(f.path, 300 * 1024);
      const state = [];
      if (trimmedContext) state.push(briefText(trimmedContext));

      state.push(`OPTION ${i}`);
      state.push({
        type: 'image_url',
        image_url: { url: `data:${recFile.mime};base64,${recFile.base64}` },
      });

      if (state.filter(p => typeof p === 'object' && p.type === 'image_url').length > 4) {
        throw new Error(`PRESCREEN_TOO_MANY_IMAGES: per-option request exceeds 4 images for clef-flash`);
      }

      const questions = buildQuestionsForOption(i, criteria);
      requests.push({
        body: { model, state, questions },
        optionIndices: [i],
        isRank: false,
      });
    }

    // Ranking request for 3-file steps
    if (files.length === 3) {
      const rankState = [];
      for (let i = 0; i < files.length; i++) {
        const rec = await recompressImageToLimit(files[i].path, 300 * 1024);
        rankState.push(`OPTION ${i}`);
        rankState.push({
          type: 'image_url',
          image_url: { url: `data:${rec.mime};base64,${rec.base64}` },
        });
      }
      if (trimmedContext) rankState.unshift(briefText(trimmedContext));
      const rankQuestions = { rank: RANK_QUESTION };
      requests.push({
        body: { model, state: rankState, questions: rankQuestions },
        optionIndices: [0, 1, 2],
        isRank: true,
      });
    }

    return requests;
  }

  throw new Error(`PRESCREEN_MODEL_UNKNOWN: ${model}`);
}

export async function runPrescreen({
  config = {},
  apiKey = null,
  secretsPath = null,
  fetcher = fetch,
  step,
  files = [],
  contextText = '',
  criteria = [],
  tracer = null,
} = {}) {
  // No `references` parameter: reference photos are never sent (likeness is Vera's).
  const model = config.model ?? 'openai/gpt-6-luna-decisions';
  const passAbove = config.passAbove ?? 0.9;
  const failBelow = config.failBelow ?? 0.4;

  let key = apiKey;
  if (!key) {
    key = await readOpenRouterKey(secretsPath);
  }

  const plannedRequests = await buildRequests({
    model,
    step,
    files,
    contextText,
    criteria,
  });

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let requestsCount = 0;
  let servedModel = model;

  const aggregatedAnswers = {};
  let rankAnswer = null;

  const estimatedCostUsd = estimatePrescreenCost({ model, files, contextText });
  const reqEstimatedCost = plannedRequests.length > 0 ? estimatedCostUsd / plannedRequests.length : estimatedCostUsd;

  for (const req of plannedRequests) {
    assertNoLikeness(req.body, files.length);
    requestsCount++;
    const timer = tracer
      ? paidJobTimer(tracer, {
          provider: 'openrouter-decisions',
          model,
          estimatedCostUsd: reqEstimatedCost,
          actualCostSource: 'provider',
        })
      : null;

    let response;
    try {
      response = await fetcher(DECISIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-Title': 'Wiggly Decisions prescreen',
        },
        body: JSON.stringify(req.body),
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      timer?.fail(err);
      throw new Error(`DECISIONS_REQUEST_FAILED: ${err.message}`);
    }

    if (!response.ok) {
      const status = response.status;
      const text = await response.text().catch(() => '');
      const err = new Error(
        status === 401 || status === 403
          ? `DECISIONS_AUTH_FAILED: HTTP ${status}`
          : status === 402
          ? `DECISIONS_CREDITS_EXHAUSTED: HTTP 402`
          : status === 413
          ? `DECISIONS_IMAGE_TOO_LARGE: HTTP 413`
          : status === 429
          ? `DECISIONS_RATE_LIMITED: HTTP 429`
          : `DECISIONS_REQUEST_FAILED: HTTP ${status} ${text.slice(0, 200)}`
      );
      timer?.fail(err);
      throw err;
    }

    const result = await response.json();
    servedModel = result.model ?? servedModel;

    const reqCost = Number(result?.usage?.cost) || 0;
    const reqTokens = Number(result?.usage?.input_tokens) || 0;
    totalCostUsd += reqCost;
    totalInputTokens += reqTokens;

    timer?.ok({ actualCostUsd: reqCost, actualCostSource: 'provider' });

    if (result.answers) {
      if (result.answers.rank) {
        rankAnswer = result.answers.rank;
      }
      for (const [k, v] of Object.entries(result.answers)) {
        if (k !== 'rank') {
          aggregatedAnswers[k] = v;
        }
      }
    }
  }

  // Parse check results for each file
  const allCriteria = prescreenCriteria(criteria);
  const fileResults = files.map((file, idx) => {
    const checks = allCriteria.map(criterion => {
      const qKey = `opt${idx}__${criterion}`;
      const ans = aggregatedAnswers[qKey];
      const prob = ans && ans.type === 'noul' && typeof ans.noul === 'number' && Number.isFinite(ans.noul) ? ans.noul : null;
      let status = 'inconclusive';
      if (prob != null) {
        if (prob >= passAbove) status = 'pass';
        else if (prob <= failBelow) status = 'fail';
      }
      return {
        criterion,
        question: PRESCREEN_QUESTIONS[criterion]?.instructions ?? criterion,
        probability: prob ?? 0.5,
        status,
      };
    });

    let verdict = 'uncertain';
    if (checks.every(c => c.status === 'pass')) {
      verdict = 'pass';
    } else if (checks.some(c => c.status === 'fail')) {
      verdict = 'fail';
    }

    return {
      index: idx,
      sha256: file.sha256,
      verdict,
      checks,
    };
  });

  // Ranking
  let ranking = null;
  let rankingConfidence = null;
  if (files.length === 3 && rankAnswer && rankAnswer.type === 'choice') {
    rankingConfidence = typeof rankAnswer.confidence === 'number' ? rankAnswer.confidence : null;
    const probs = rankAnswer.probabilities ?? {};
    ranking = [0, 1, 2].sort((a, b) => (probs[String(b)] ?? 0) - (probs[String(a)] ?? 0));
  }

  // Artifact verdict
  let artifactVerdict = 'uncertain';
  const allFilesPass = fileResults.length > 0 && fileResults.every(f => f.verdict === 'pass');
  const allCriteriaCovered = fileResults.every(f =>
    allCriteria.every(crit => f.checks.some(c => c.criterion === crit))
  );
  const rankingPresentIfThree = files.length === 3 ? ranking != null : true;

  if (allFilesPass && allCriteriaCovered && rankingPresentIfThree) {
    artifactVerdict = 'pass';
  } else if (fileResults.some(f => f.verdict === 'fail')) {
    artifactVerdict = 'fail';
  }

  return {
    provider: 'openrouter-decisions',
    model,
    servedModel,
    verdict: artifactVerdict,
    files: fileResults,
    ranking: files.length > 1 ? ranking : null,
    rankingConfidence: files.length > 1 ? rankingConfidence : null,
    thresholds: { passAbove, failBelow },
    usage: {
      requests: requestsCount,
      inputTokens: totalInputTokens,
      costUsd: totalCostUsd,
      estimatedCostUsd,
    },
    at: new Date().toISOString(),
  };
}
