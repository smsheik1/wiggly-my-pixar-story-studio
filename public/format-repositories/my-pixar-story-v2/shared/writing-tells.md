# Writing tells: film and short-screenplay rubric (Wiggly v2)

Adapted from the AI TELLS SCORING RUBRIC v2.2 for family films told in shots, dialogue and voiceover.
Who uses it: the Story Director and Seedance Compiler (their do-not-write list), the code linter
(`crew/linter/writing-tells.mjs`, reads the JSON block at the end), and the reflection/critic step, which scores every draft against this file.

The goal: the film sounds like this family, not like a machine writing about a family.

---

## Pre-check: forced negation (run first)
Search every spoken or narrated line for:
- "it's not X, it's Y" / "not X, just Y" / "that wasn't X, it was Y"
- "these aren't X, these are Y" / "didn't just X, they Y" / "not a X, it's a Y"
Quote each one and rewrite it as a direct positive line before scoring anything else.

---

## Step 1: scan and flag (quote the exact line)

### A. Story and structure tells (3 points each)
- **Wrap-up moral.** The scene stops being the scene and explains what it all meant. "In the end, it was never about the car." End on the last concrete thing instead.
- **Inspirational pivot.** A specific memory zooms out to a vague life lesson. "He got his license at seventeen. Sometimes freedom finds us." Stay in the memory.
- **Specificity avoidance.** Generic stand-ins where the answers gave real details: "a car" for the faded 2000 Honda Accord Coupe, "a card game" for Yugioh, "every week" with the 8pm dropped. The oddly specific real details are the film.
- **Losing the answers' details.** A detail the maker wrote (name, age, object, time, quote) is softened, swapped or missing. Count each one.
- **Staccato triplets / rule of three.** Three short lines or three parallel items hammered in a row. "He showed up. He listened. He stayed." Use two, or four, or one long line.
- **Forced negation.** "It's not a setback, it's a setup." State it directly.
- **Symmetrical scaffolding.** "Not because X, but because Y." "Less X, more Y." "Where X meets Y." Remove the frame; if nothing is left, cut the line.
- **Pivot closer / mic-drop closer.** A short slogan that makes a beat "land". "And that changed everything." "That's family."
- **Uniform beat structure.** Every part runs setup, twist, explanation, punchy closer. Read the last line of each part back to back: if all three are poetic and self-contained, at least one part must just stop on an ordinary moment.
- **Characters announcing their feelings.** "I'm so proud of you." "I feel free." People show it: a grin, a pause, a joke, a thing they do.
- **Everyone speaks in the same voice.** The 8-year-old, the teen sister, the mom and the dad all have the same rhythm and vocabulary. Each person needs their own words.
- **The theme said out loud.** A character states what the film is about. "Family is what you make of it."
- **Voiceover reading a resume.** Narration lists achievements, salaries, certifications and dates like a CV. Pick the one fact that carries feeling and tie it to an image.
- **Stacked wisdom lines.** Three or more advice or moral lines in a row in the finale. Break them up with an on-screen action that shows what the words mean (a shot where someone does something), never by inserting an unrelated memory or callback.
- **Forced callbacks.** An earlier object or line is dragged back in only to tie a bow, with no reason in the scene.
- **Kid dialogue that sounds written.** Children speak in complete, polished, quotable sentences. Real kids interrupt, repeat, mispronounce, brag, and say odd things.
- **Platitudes.** Sweeping generalisations about life, love, family, men and women, "the world". Keep only wisdom the answers ground in this family.
- **Setup/reveal and contrast pivot.** "Everyone thought it was just a car. It was freedom." "Different city. Different job. Same Shaz." Say the true thing once.
- **Manufactured surprise.** "Here's the crazy part", "and that's when it hit me", "all along", "this whole time", "the only thing that mattered was X". Let the moment be the surprise.
- **Over-explaining.** A line explains what the picture already shows, or a metaphor gets explained or milked across several shots ("the cards were our language... every hand was a sentence").
- **Parallel restatement.** The same feeling said two or three ways in a row.
- **Rhetorical Q and A.** "Was it easy? No." Once is fine; twice is a pattern.
- **Performative reflection.** "I sat with that." "Let that sink in." Show the thought instead.
- **Generic positive ending.** "And they lived happily." "The best was yet to come." End on something only this family has.

### B. Line-level and format tells (2 points each)
- **Any em dash in a spoken or narrated line** (zero tolerance). Use a comma, a period, or two lines.
- **Zero contractions in dialogue or voiceover.** "I do not", "it is", "I will" in casual speech. Spoken lines use "don't", "it's", "I'll".
- **Filler stage directions.** A shot whose only action is "breathing", "blinking", "smiles softly" or "nods slowly". Moving holds (breathing, blinking on a held beat) are required by both roles for the video model and are not a tell; flag only shots with no specific action besides them. Critic only, not a code check.
- **Colon or "here's the thing" reveals inside dialogue.**
- **CAPS for emphasis in a line.**
- **Stiff register.** Formal or written words in casual speech ("purchase", "commence", "individuals"), or "the exact [noun]" claiming precision without giving it.

### C. Flagged words and phrases (1 point each)
Phrases: "a testament to", "rich tapestry", "a stark reminder", "at the end of the day", "in the grand scheme of things", "the lesson here", "it's a reminder that", "more than ever", "deeply rooted", "journey" (as life metaphor), "embrace", "cherish every moment", "treasure", "unwavering", "indelible", "heart of the home", "little did I know", "and that changed everything", "that's the whole game", "in the end, it was", "the journey of life", "family is everything", "home is where the heart is".
Words: delve, tapestry, testament, profound, resonate, vibrant, nestled, bustling, whimsical, palpable, cornerstone, myriad, embark, journey, cherish, unwavering, indelible, essence, transformative, poignant, bittersweet (as label), heartfelt (as label), genuinely, literally, truly (empty intensifiers).

### D. Tone tells (3 points each)
- **Greeting-card tone.** Sweet, smooth and empty; could be on any family's card.
- **Soulless clean writing.** Every line the same length, no humour, no mess, no odd detail.
- **No point of view.** Could be anyone's dad talking to anyone's kid.

### E. Pipeline bleed (5 points each)
- Leftover placeholders ("[Name]", "TBD"), asset keys, file paths or field names inside a line or prompt.
- Instructions to the model inside a spoken line.

---

## Step 2: score it

| Score | Rating | Action |
|---|---|---|
| 0–5 | CLEAN | Ship. Minor polish only. |
| 6–15 | LIGHT EDIT | Fix the flagged lines. |
| 16–30 | REWRITE PASS | Rewrite flagged scenes with the answers' specifics and distinct voices. |
| 31–50 | HEAVY REWRITE | Keep the beat outline; rewrite every line. |
| 51+ | START OVER | Keep the facts, trash the script. |

## Step 3: fix rules
- Forced negation → one direct line.
- Triplets → two beats, or one longer line.
- Wrap-up moral, inspirational pivot, theme said out loud → cut; end on the last concrete image or action.
- Announced feelings → an action, a look, a joke or a specific detail.
- Same voice → give each person their own words: the kid brags and interrupts, the teen is dry, the parent is plain.
- Resume voiceover → one fact, tied to an image, said like a person would say it.
- Stacked wisdom → no more than two advice lines in a row; put an on-screen action between them that shows the idea, not an inserted memory.
- Forced callback → only if the scene needs it.
- Em dash → comma, period or two lines. Missing contractions → add them.
- Filler stage directions → add one specific action next to the moving hold.
- Lost detail → put the exact detail from the answers back in.

## Step 4: output format (the critic returns this)
```
SCORE: <number> (<RATING>)
FLAGS:
| # | Part/shot | Line (quoted) | Tell | Points | Suggested fix |
TOP 3 PRIORITIES:
1. ...
REWRITTEN LINES (only if score >= 16):
- Part X shot Y: "<new line>"
```

## Do-not-write list (loaded into the Story Director and Seedance Compiler)
- No em dashes in spoken or narrated lines.
- No "it's not X, it's Y" or any forced negation.
- No wrap-up morals, no theme said out loud, no platitudes about life, love, family, men and women or "the world".
- No more than two wisdom or advice lines in a row in the finale; break a run with an on-screen action that shows the idea, never with an inserted memory or callback.
- No three-beat staccato runs ("He showed up. He listened. He stayed.").
- No characters announcing their feelings ("I'm so proud", "I feel free").
- No resume voiceover (salary, certifications, dates read as a list).
- Every shot gets one specific action; a moving hold alone (breathing, blinking) is not enough.
- Use contractions in speech ("don't", "it's", "I'll").
- Kids talk like kids: short, interrupting, bragging, odd.
- Keep the answers' oddly specific details exactly as written.
- None of the flagged words or phrases in section C.

## What the code enforces
The linter reads the JSON block below. Everything else in this file is for the writers and the critic.
- **Hard fail (blocks the gate):** an em dash in a spoken or narrated line (`WRITING_TELL_EM_DASH`), forced negation (`WRITING_TELL_FORCED_NEGATION`), a phrase in `hard.phrases` (`WRITING_TELL_BANNED_PHRASE`).
- **Warning (reported, never blocks):** a word in `warn.words` (`WRITING_TELL_FLAGGED_WORD`), more than `wisdomStackMax` wisdom lines in a row in the finale (`WRITING_TELL_WISDOM_STACK`), no or few contractions in speech (`WRITING_TELL_NO_CONTRACTIONS`, `WRITING_TELL_FEW_CONTRACTIONS`).
- Not checked by code: em dashes in Seedance prompt prose (the Seedance role's own camera phrases use them and the viewer never hears them) and filler directions (moving holds are required).

## Machine-readable block (read by crew/linter/writing-tells.mjs)
<!-- writing-tells:json:start -->
```json
{
  "version": "film-1.1 (from AI TELLS v2.2)",
  "hard": {
    "emDash": "\u2014",
    "forcedNegation": [
      "\\b(?:it|this|that)(?:(?:'s| is| was)(?: just)? not| isn't| wasn't) (?:about )?[^,.;]{1,40}[,.;]\\s*(?:it|this|that)(?:'s| is| was)\\b",
      "\\b(?:these|they) (?:aren't|are not|weren't) [^,.;]{1,40}[,.;]\\s*(?:these|they) (?:are|were)\\b",
      "\\b(?:didn't|did not) just [^,.;]{1,40}[,.;]\\s*(?:they|he|she|we|i) [a-z]+",
      "\\bnot an? [^,.;]{1,30}[,.;]\\s*(?:it's|it is) an?\\b",
      "\\bnot [^,.;]{1,30}\\s*(?:\u2014|--)\\s*just\\b"
    ],
    "phrases": [
      "it's a reminder that", "in the end, it was", "the lesson here", "at the end of the day", "in the grand scheme of things",
      "a testament to", "rich tapestry", "a stark reminder", "and that changed everything", "that's the whole game",
      "little did i know", "cherish every moment", "the journey of life", "family is everything", "home is where the heart is"
    ]
  },
  "warn": {
    "words": ["delve", "tapestry", "testament", "profound", "resonate", "vibrant", "nestled", "bustling", "whimsical", "palpable",
      "cornerstone", "myriad", "embark", "journey", "cherish", "unwavering", "indelible", "essence", "transformative", "poignant",
      "genuinely", "literally", "truly", "embrace"],
    "wisdomLine": "\\b(you (?:are|become|turn into) what|good people|the world|love (?:is|means)|always|never forget|remember that|life|think about|notice the good|people can|be kind|be yourself|in the end)\\b",
    "wisdomStackMax": 2,
    "contractable": "\\b(do not|does not|did not|is not|are not|was not|will not|cannot|can not|i am|it is|that is|you are|we are|they are|i will|you will|i would|let us|i have)\\b",
    "contraction": "\\b\\w+'(?:t|s|re|ll|ve|d|m)\\b",
    "minContractableForWarning": 3
  }
}
```
<!-- writing-tells:json:end -->
