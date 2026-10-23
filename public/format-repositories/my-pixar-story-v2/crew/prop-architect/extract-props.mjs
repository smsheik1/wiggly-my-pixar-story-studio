// Autonomous Hero Prop Extractor: scans the StagePlay scenes and shots for recurring
// or hero vehicles, accessories, and key story objects that require visual continuity sheets.

const HERO_PROP_PATTERNS = [
  /\b(?:car|automobile|coupe|sedan|truck|van|vehicle|convertible|station\s+wagon)\b/i,
  /\b(?:guitar|piano|violin|drums|keyboard|instrument)\b/i,
  /\b(?:photo|frame|framed|ultrasound|portrait|locket)\b/i,
  /\b(?:book|journal|diary|novel|binder)\b/i,
  /\b(?:cards?|deck|card\s+deck|trading\s+cards?|playing\s+cards?)\b/i,
  /\b(?:ring|necklace|watch|heirloom|amulet)\b/i,
  /\b(?:laptop|computer|terminal|monitor)\b/i,
];

export function isHeroProp(propText = '') {
  return HERO_PROP_PATTERNS.some((pat) => pat.test(propText));
}

export function slugify(text = '') {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Extracts hero props from the stage play scenes and shots.
 * Returns an array of normalized HeroProp objects.
 */
export function extractHeroProps(stagePlay = {}) {
  const seenNames = new Map();
  const segments = stagePlay.segments ?? [];

  for (const seg of segments) {
    for (const sc of seg.scenes ?? []) {
      for (const p of sc.props ?? []) {
        const text = String(p).trim();
        if (!text) continue;
        if (isHeroProp(text)) {
          // Normalize clean name
          const clean = text.replace(/^(the|a|an)\s+/i, '').split(/\s+(?:parked|held|sitting|spread|resting|placed|turned)\b/i)[0].trim();
          const baseName = clean.replace(/\.$/, '');
          const count = (seenNames.get(baseName)?.count ?? 0) + 1;
          seenNames.set(baseName, { raw: text, count });
        }
      }
    }
  }

  const out = [];
  let idx = 1;
  for (const [name, meta] of seenNames.entries()) {
    const slug = slugify(name);
    out.push({
      propTag: `@Prop ${idx}`,
      elementTag: `@${slug}`,
      name,
      description: meta.raw,
      assetKey: `asset:prop-sheet:${slug.replace(/_/g, '-')}`,
      occurrences: meta.count
    });
    idx++;
  }

  return out;
}

/**
 * Generates the standardized 4-view 3D turnaround prompt for a hero vehicle or object.
 */
export function generatePropTurnaroundPrompt(prop, photoUrls = []) {
  const photoClause = photoUrls?.length ? ` Matching real-life reference photos: ${photoUrls.join(', ')}.` : '';
  return `Multi-angle model sheet of ${prop.name}, Pixar-style 3D stylized turnaround: front 3/4 view, side profile, and rear 3/4 view. Characterized by slightly rounded exaggerated proportions, rich tactile materials, tactile textures, and subtle story-specific wear.${photoClause} Neutral gray studio lighting, crisp shadows, feature animation production asset.`;
}

