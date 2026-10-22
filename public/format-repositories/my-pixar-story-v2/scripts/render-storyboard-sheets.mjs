import sharp from '/Users/shaz/Projects/wiggly/node_modules/sharp/lib/index.js';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const runDir = '/Users/shaz/Projects/wiggly-my-pixar-story-studio/public/format-repositories/my-pixar-story-v2/runs/r6-live';
const panelsDir = join(runDir, 'storyboard-panels');
const exportDir = join(runDir, 'storyboard-export');
const artifactDir = '/Users/shaz/.gemini/antigravity/brain/8574b48e-ceb5-4f27-bf76-83c6902bfcbe';

const timings = JSON.parse(await readFile(join(runDir, 'approvedShotTimings.json'), 'utf8'));
const timingMap = Object.fromEntries(timings.map(t => [t.shotId, t]));

const sd = JSON.parse(await readFile(join(runDir, 'outputs', 'story-director.json'), 'utf8'));

// Build shot details map
const shotDetails = {};
for (const seg of sd.segments) {
  for (const sh of seg.shots) {
    const id = `${seg.segmentId}.${sh.shotNumber}`;
    const t = timingMap[id] || { startSec: sh.startSec, endSec: sh.endSec, durationSec: sh.endSec - sh.startSec };
    let speaker = sh.narration?.speaker || sh.dialogue?.speaker || '';
    let line = (sh.narration?.line || sh.dialogue?.line || '').replace(/[{}]/g, '').trim();
    if (sh.narration && sh.dialogue) {
      speaker = `${sh.narration.speaker} & ${sh.dialogue.speaker}`;
      line = `${sh.narration.line.replace(/[{}]/g, '').trim()} — @Wife: “${sh.dialogue.line.replace(/[{}]/g, '').trim()}”`;
    }
    shotDetails[id] = {
      shotId: id,
      segmentId: seg.segmentId,
      framing: sh.framing,
      cameraAngle: sh.cameraAngle,
      speaker,
      line,
      startSec: t.startSec,
      endSec: t.endSec,
      durationSec: t.durationSec,
      whatWeSee: sh.whatWeSee || ''
    };
  }
}

function escapeXml(unsafe) {
  return String(unsafe || '').replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function formatSec(sec) {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}`;
}

async function renderSheet1() {
  const width = 3840;
  const height = 2160;
  const shotIds = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7'];
  
  // Row 1: 4 panels
  // Row 2: 3 panels centered
  const pw = 840;
  const ph = 472; // 16:9
  const gap = 80;
  
  const colX_row1 = [120, 120 + pw + gap, 120 + (pw + gap)*2, 120 + (pw + gap)*3];
  const colX_row2 = [580, 580 + pw + gap, 580 + (pw + gap)*2];
  
  const row1_y = 230;
  const row2_y = 1040;
  
  const layout = [
    { id: '1.1', x: colX_row1[0], y: row1_y },
    { id: '1.2', x: colX_row1[1], y: row1_y },
    { id: '1.3', x: colX_row1[2], y: row1_y },
    { id: '1.4', x: colX_row1[3], y: row1_y },
    { id: '1.5', x: colX_row2[0], y: row2_y },
    { id: '1.6', x: colX_row2[1], y: row2_y },
    { id: '1.7', x: colX_row2[2], y: row2_y },
  ];
  
  const composites = [];
  
  // Base background
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#F6F4EE" />
    
    <!-- Top Header -->
    <rect x="80" y="40" width="3680" height="110" rx="8" fill="#ECE8DF" />
    <text x="120" y="80" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="16" font-weight="700" letter-spacing="2" fill="#7A7468">PIXAR STORY STUDIO • STORYBOARD DEPARTMENT</text>
    <text x="120" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="34" font-weight="800" fill="#201E1B">SHAZ FOR MIA</text>
    <text x="440" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="24" font-weight="500" fill="#5A544A">— PART 1: SCIENTIST &amp; CARD BATTLES (LIVING ROOM)</text>
    
    <text x="3720" y="85" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="18" font-weight="700" fill="#201E1B">SHEET 1 OF 3</text>
    <text x="3720" y="120" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="15" font-weight="500" fill="#7A7468">7 PANELS • TOTAL 18.0s • NANO-BANANA 2K</text>
    <line x1="80" y1="175" x2="3760" y2="175" stroke="#DFD9CD" stroke-width="2" />
  `;
  
  for (const item of layout) {
    const s = shotDetails[item.id];
    const imgPath = join(panelsDir, `${item.id}.png`);
    const resizedPanel = await sharp(imgPath).resize(pw, ph).toBuffer();
    composites.push({ input: resizedPanel, left: item.x, top: item.y });
    
    // SVG Labels & Dialogue Card
    const headerY = item.y - 12;
    const cardY = item.y + ph + 10;
    const cardH = 160;
    
    svg += `
      <!-- Header above panel -->
      <text x="${item.x}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="18" font-weight="800" fill="#2A2825">SHOT ${s.shotId}</text>
      <text x="${item.x + 110}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="600" fill="#7A7468">${escapeXml(s.framing.toUpperCase())} • ${formatSec(s.startSec)} - ${formatSec(s.endSec)} (${s.durationSec}s)</text>
      
      <!-- Panel Border -->
      <rect x="${item.x - 2}" y="${item.y - 2}" width="${pw + 4}" height="${ph + 4}" rx="4" fill="none" stroke="#2B2823" stroke-width="4" />
      
      <!-- Dialogue Card below panel -->
      <rect x="${item.x}" y="${cardY}" width="${pw}" height="${cardH}" rx="6" fill="#EDE9DF" stroke="#DCD6C8" stroke-width="1.5" />
      <rect x="${item.x + 16}" y="${cardY + 16}" width="${s.speaker.length * 10 + 20}" height="26" rx="4" fill="#3D3A34" />
      <text x="${item.x + 26}" y="${cardY + 34}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="13" font-weight="700" fill="#F8F6F0">${escapeXml(s.speaker)}</text>
      
      <text x="${item.x + 16}" y="${cardY + 75}" font-family="Georgia, serif" font-size="17" font-style="italic" font-weight="500" fill="#201E1B">“${escapeXml(s.line)}”</text>
      <text x="${item.x + 16}" y="${cardY + 115}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="13" font-weight="400" fill="#655F55">${escapeXml(s.whatWeSee.slice(0, 95))}${s.whatWeSee.length > 95 ? '...' : ''}</text>
    `;
  }
  
  // Footer
  svg += `
    <line x1="80" y1="1980" x2="3760" y2="1980" stroke="#DFD9CD" stroke-width="2" />
    <text x="120" y="2020" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="600" fill="#7A7468">DIRECTOR: SHAZ • HEAD OF STORY: DAN KIEFT • FORMAT: PIXAR MEMOIR V2 • STAGING: DECOUPLED RIG ROOT Universal 1.0</text>
    <text x="3720" y="2020" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="700" fill="#7A7468">APPROVED PRODUCTION MASTER CONTINUITY</text>
  </svg>`;
  
  const svgBuffer = Buffer.from(svg);
  const outPath = join(exportDir, 'sheet-1.png');
  const artPath = join(artifactDir, 'storyboard-sheet-1.png');
  
  await sharp(svgBuffer)
    .composite(composites)
    .png()
    .toFile(outPath);
  
  await sharp(outPath).toFile(artPath);
  console.log('Sheet 1 written to', outPath, 'and', artPath);
}

async function renderSheet2() {
  const width = 3840;
  const height = 2160;
  
  const pw = 840;
  const ph = 472;
  const gap = 80;
  
  const colX_row1 = [120, 120 + pw + gap, 120 + (pw + gap)*2, 120 + (pw + gap)*3];
  const colX_row2 = [580, 580 + pw + gap, 580 + (pw + gap)*2];
  
  const row1_y = 230;
  const row2_y = 1040;
  
  const layout = [
    { id: '2.1', x: colX_row1[0], y: row1_y },
    { id: '2.2', x: colX_row1[1], y: row1_y },
    { id: '2.3', x: colX_row1[2], y: row1_y },
    { id: '2.4', x: colX_row1[3], y: row1_y },
    { id: '2.5', x: colX_row2[0], y: row2_y },
    { id: '2.6', x: colX_row2[1], y: row2_y },
    { id: '2.7', x: colX_row2[2], y: row2_y },
  ];
  
  const composites = [];
  
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#F6F4EE" />
    
    <!-- Top Header -->
    <rect x="80" y="40" width="3680" height="110" rx="8" fill="#ECE8DF" />
    <text x="120" y="80" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="16" font-weight="700" letter-spacing="2" fill="#7A7468">PIXAR STORY STUDIO • STORYBOARD DEPARTMENT</text>
    <text x="120" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="34" font-weight="800" fill="#201E1B">SHAZ FOR MIA</text>
    <text x="440" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="24" font-weight="500" fill="#5A544A">— PART 2: FREEDOM &amp; FIRST JOB (DRIVEWAY, HONDA ACCORD, DESK)</text>
    
    <text x="3720" y="85" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="18" font-weight="700" fill="#201E1B">SHEET 2 OF 3</text>
    <text x="3720" y="120" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="15" font-weight="500" fill="#7A7468">7 PANELS • TOTAL 30.3s • NANO-BANANA 2K</text>
    <line x1="80" y1="175" x2="3760" y2="175" stroke="#DFD9CD" stroke-width="2" />
  `;
  
  for (const item of layout) {
    const s = shotDetails[item.id];
    const imgPath = join(panelsDir, `${item.id}.png`);
    const resizedPanel = await sharp(imgPath).resize(pw, ph).toBuffer();
    composites.push({ input: resizedPanel, left: item.x, top: item.y });
    
    const headerY = item.y - 12;
    const cardY = item.y + ph + 10;
    const cardH = 160;
    
    svg += `
      <text x="${item.x}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="18" font-weight="800" fill="#2A2825">SHOT ${s.shotId}</text>
      <text x="${item.x + 110}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="600" fill="#7A7468">${escapeXml(s.framing.toUpperCase())} • ${formatSec(s.startSec)} - ${formatSec(s.endSec)} (${s.durationSec}s)</text>
      
      <rect x="${item.x - 2}" y="${item.y - 2}" width="${pw + 4}" height="${ph + 4}" rx="4" fill="none" stroke="#2B2823" stroke-width="4" />
      
      <rect x="${item.x}" y="${cardY}" width="${pw}" height="${cardH}" rx="6" fill="#EDE9DF" stroke="#DCD6C8" stroke-width="1.5" />
      <rect x="${item.x + 16}" y="${cardY + 16}" width="${s.speaker.length * 10 + 20}" height="26" rx="4" fill="#3D3A34" />
      <text x="${item.x + 26}" y="${cardY + 34}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="13" font-weight="700" fill="#F8F6F0">${escapeXml(s.speaker)}</text>
      
      <text x="${item.x + 16}" y="${cardY + 75}" font-family="Georgia, serif" font-size="17" font-style="italic" font-weight="500" fill="#201E1B">“${escapeXml(s.line)}”</text>
      <text x="${item.x + 16}" y="${cardY + 115}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="13" font-weight="400" fill="#655F55">${escapeXml(s.whatWeSee.slice(0, 95))}${s.whatWeSee.length > 95 ? '...' : ''}</text>
    `;
  }
  
  svg += `
    <line x1="80" y1="1980" x2="3760" y2="1980" stroke="#DFD9CD" stroke-width="2" />
    <text x="120" y="2020" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="600" fill="#7A7468">DIRECTOR: SHAZ • HEAD OF STORY: DAN KIEFT • FORMAT: PIXAR MEMOIR V2 • STAGING: DECOUPLED RIG ROOT Universal 1.0</text>
    <text x="3720" y="2020" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="700" fill="#7A7468">APPROVED PRODUCTION MASTER CONTINUITY</text>
  </svg>`;
  
  const svgBuffer = Buffer.from(svg);
  const outPath = join(exportDir, 'sheet-2.png');
  const artPath = join(artifactDir, 'storyboard-sheet-2.png');
  
  await sharp(svgBuffer)
    .composite(composites)
    .png()
    .toFile(outPath);
  
  await sharp(outPath).toFile(artPath);
  console.log('Sheet 2 written to', outPath, 'and', artPath);
}

async function renderSheet3() {
  const width = 3840;
  const height = 2160;
  
  // 6 panels: 2 rows of 3 panels
  const pw = 1100;
  const ph = 618; // 16:9
  const gap = 120;
  
  const colX = [150, 150 + pw + gap, 150 + (pw + gap)*2];
  const row1_y = 230;
  const row2_y = 1100;
  
  const layout = [
    { id: '3.1', x: colX[0], y: row1_y },
    { id: '3.2', x: colX[1], y: row1_y },
    { id: '3.3', x: colX[2], y: row1_y },
    { id: '3.4', x: colX[0], y: row2_y },
    { id: '3.5', x: colX[1], y: row2_y },
    { id: '3.6', x: colX[2], y: row2_y },
  ];
  
  const composites = [];
  
  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#F6F4EE" />
    
    <!-- Top Header -->
    <rect x="80" y="40" width="3680" height="110" rx="8" fill="#ECE8DF" />
    <text x="120" y="80" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="16" font-weight="700" letter-spacing="2" fill="#7A7468">PIXAR STORY STUDIO • STORYBOARD DEPARTMENT</text>
    <text x="120" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="34" font-weight="800" fill="#201E1B">SHAZ FOR MIA</text>
    <text x="440" y="125" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="24" font-weight="500" fill="#5A544A">— PART 3: SHOWING UP &amp; LOVE (DALLAS, CHICAGO, MIA FINALE)</text>
    
    <text x="3720" y="85" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="18" font-weight="700" fill="#201E1B">SHEET 3 OF 3</text>
    <text x="3720" y="120" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="15" font-weight="500" fill="#7A7468">6 PANELS • TOTAL 21.6s • NANO-BANANA 2K</text>
    <line x1="80" y1="175" x2="3760" y2="175" stroke="#DFD9CD" stroke-width="2" />
  `;
  
  for (const item of layout) {
    const s = shotDetails[item.id];
    const imgPath = join(panelsDir, `${item.id}.png`);
    const resizedPanel = await sharp(imgPath).resize(pw, ph).toBuffer();
    composites.push({ input: resizedPanel, left: item.x, top: item.y });
    
    const headerY = item.y - 12;
    const cardY = item.y + ph + 10;
    const cardH = 150;
    
    svg += `
      <text x="${item.x}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="20" font-weight="800" fill="#2A2825">SHOT ${s.shotId}</text>
      <text x="${item.x + 120}" y="${headerY}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="15" font-weight="600" fill="#7A7468">${escapeXml(s.framing.toUpperCase())} • ${formatSec(s.startSec)} - ${formatSec(s.endSec)} (${s.durationSec}s)</text>
      
      <rect x="${item.x - 2}" y="${item.y - 2}" width="${pw + 4}" height="${ph + 4}" rx="4" fill="none" stroke="#2B2823" stroke-width="4" />
      
      <rect x="${item.x}" y="${cardY}" width="${pw}" height="${cardH}" rx="6" fill="#EDE9DF" stroke="#DCD6C8" stroke-width="1.5" />
      <rect x="${item.x + 16}" y="${cardY + 16}" width="${s.speaker.length * 10 + 20}" height="26" rx="4" fill="#3D3A34" />
      <text x="${item.x + 26}" y="${cardY + 34}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="13" font-weight="700" fill="#F8F6F0">${escapeXml(s.speaker)}</text>
      
      <text x="${item.x + 16}" y="${cardY + 75}" font-family="Georgia, serif" font-size="18" font-style="italic" font-weight="500" fill="#201E1B">“${escapeXml(s.line)}”</text>
      <text x="${item.x + 16}" y="${cardY + 115}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="400" fill="#655F55">${escapeXml(s.whatWeSee.slice(0, 115))}${s.whatWeSee.length > 115 ? '...' : ''}</text>
    `;
  }
  
  svg += `
    <line x1="80" y1="1980" x2="3760" y2="1980" stroke="#DFD9CD" stroke-width="2" />
    <text x="120" y="2020" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="600" fill="#7A7468">DIRECTOR: SHAZ • HEAD OF STORY: DAN KIEFT • FORMAT: PIXAR MEMOIR V2 • STAGING: DECOUPLED RIG ROOT Universal 1.0</text>
    <text x="3720" y="2020" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica" font-size="14" font-weight="700" fill="#7A7468">APPROVED PRODUCTION MASTER CONTINUITY</text>
  </svg>`;
  
  const svgBuffer = Buffer.from(svg);
  const outPath = join(exportDir, 'sheet-3.png');
  const artPath = join(artifactDir, 'storyboard-sheet-3.png');
  
  await sharp(svgBuffer)
    .composite(composites)
    .png()
    .toFile(outPath);
  
  await sharp(outPath).toFile(artPath);
  console.log('Sheet 3 written to', outPath, 'and', artPath);
}

await renderSheet1();
await renderSheet2();
await renderSheet3();
console.log('All 3 storyboard sheets generated successfully!');
