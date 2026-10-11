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
    instructions: 'Does this image contain no visible text, letters, labels, captions, watermarks or UI elements?',
    criteria: {
      true: 'No text, letters, labels, captions, watermarks or UI are visible anywhere in the image',
      false: 'There is visible text, letters, labels, captions, watermarks or UI in the image',
    },
  },
  'style': {
    type: 'noul',
    instructions: 'Is this image rendered in stylized 3D animated-feature (Pixar-like) style, and not photoreal and not 2D?',
    criteria: {
      true: 'Stylized 3D animated-feature Pixar-like rendering with appealing shapes, soft lighting and caricatured proportions',
      false: 'Photoreal, photographic skin/textures, uncanny-valley realism, 2D drawing, sketch or flat style',
    },
  },
  'anatomy': {
    type: 'noul',
    instructions: 'Is the anatomy well-formed with no extra, missing or fused fingers/limbs and no melted faces?',
    criteria: {
      true: 'Clean natural anatomy with correct number of fingers/limbs, proper joints and clean facial features',
      false: 'Malformed limbs, extra or missing fingers, fused hands, distorted anatomy or melted facial features',
    },
  },
  'likeness': {
    type: 'noul',
    instructions: 'Does the character visibly match the reference photos in facial identity, features and character design?',
    criteria: {
      true: 'Clear facial likeness and character identity matching the reference photos',
      false: 'Does not look like the reference photos or has different key facial features',
    },
  },
  'consistency': {
    type: 'noul',
    instructions: 'Does the character have a consistent outfit, hair and appearance across all views?',
    criteria: {
      true: 'Identical clothing, hairstyle, colors and features across all views',
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

export function estimatePrescreenCost({ model, files = [], references = [], contextText = '' }) {
  const modelInfo = DECISION_MODELS[model];
  if (!modelInfo) return 0.002;

  const totalImages = files.length + references.length;
  // Estimate ~1600 tokens per image (roughly 4 base64 chars per token)
  const imageTokens = totalImages * 1600;
  const textTokens = Math.ceil(contextText.length / 4);
  const totalInputTokens = imageTokens + textTokens + 1000; // plus instructions

  return (totalInputTokens / 1_000_000) * modelInfo.inputUsdPerM;
}

export function buildQuestionsForOption(optionIdx, criteriaList) {
  const questions = {};
  const allCriteria = [...criteriaList, 'no-text'];

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
  references = [],
  contextText = '',
  criteria = [],
}) {
  const modelInfo = DECISION_MODELS[model];
  if (!modelInfo) {
    throw new Error(`PRESCREEN_MODEL_UNKNOWN: add it to DECISION_MODELS with its documented limits`);
  }

  if (model === 'openai/gpt-6-luna-decisions') {
    const totalImages = files.length + references.length;
    if (totalImages > modelInfo.maxImages) {
      throw new Error(`PRESCREEN_TOO_MANY_IMAGES: ${totalImages} exceeds ${modelInfo.maxImages}`);
    }

    const state = [];
    if (contextText) {
      state.push(contextText);
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

    for (let r = 0; r < references.length; r++) {
      const ref = references[r];
      const name = ref.name ?? `ref-${r}`;
      state.push(`REFERENCE: ${name}`);
      const buf = await readFile(ref.path);
      const ext = extname(ref.path).slice(1).replace('jpg', 'jpeg').toLowerCase();
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
      questions['rank'] = {
        type: 'choice',
        instructions: 'Which option best fits the brief and rubric?',
        criteria: { '0': 'OPTION 0', '1': 'OPTION 1', '2': 'OPTION 2' },
      };
    }

    return [{ body: { model, state, questions }, optionIndices: files.map((_, i) => i), isRank: files.length === 3 }];
  }

  if (model === 'cloudflare/clef-flash') {
    // clef-flash: <=4 images per request, ~2K text tokens read.
    // One request per option holding that option plus up to 3 references.
    if (files.length > 4) {
      throw new Error(`PRESCREEN_TOO_MANY_IMAGES: clef-flash supports at most 4 images per request`);
    }
    const requests = [];
    const trimmedContext = contextText ? contextText.slice(0, 6000) : '';

    const recompressedRefs = [];
    for (const ref of references.slice(0, 3)) {
      recompressedRefs.push({
        ref,
        rec: await recompressImageToLimit(ref.path, 300 * 1024),
      });
    }

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const recFile = await recompressImageToLimit(f.path, 300 * 1024);
      const state = [];
      if (trimmedContext) state.push(trimmedContext);

      state.push(`OPTION ${i}`);
      state.push({
        type: 'image_url',
        image_url: { url: `data:${recFile.mime};base64,${recFile.base64}` },
      });

      for (let r = 0; r < recompressedRefs.length; r++) {
        const item = recompressedRefs[r];
        state.push(`REFERENCE: ${item.ref.name ?? r}`);
        state.push({
          type: 'image_url',
          image_url: { url: `data:${item.rec.mime};base64,${item.rec.base64}` },
        });
      }

      if (state.filter(p => typeof p === 'object' && p.type === 'image_url').length > 4) {
        throw new Error(`PRESCREEN_TOO_MANY_IMAGES: per-option request exceeds 4 images for clef-flash`);
      }

      const questions = buildQuestionsForOption(i, criteria);
      requests.push({
        body: { model, state, questions },
        optionIndices: [i],
        isRank: false,
        droppedReferences: references.length > 3 ? references.length - 3 : 0,
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
      const rankQuestions = {
        rank: {
          type: 'choice',
          instructions: 'Which option best fits the brief and rubric?',
          criteria: { '0': 'OPTION 0', '1': 'OPTION 1', '2': 'OPTION 2' },
        },
      };
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
  references = [],
  contextText = '',
  criteria = [],
  tracer = null,
} = {}) {
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
    references,
    contextText,
    criteria,
  });

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let requestsCount = 0;
  let servedModel = model;

  const aggregatedAnswers = {};
  let rankAnswer = null;

  const estimatedCostUsd = estimatePrescreenCost({ model, files, references, contextText });
  const reqEstimatedCost = plannedRequests.length > 0 ? estimatedCostUsd / plannedRequests.length : estimatedCostUsd;

  for (const req of plannedRequests) {
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
  const allCriteria = [...criteria, 'no-text'];
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
