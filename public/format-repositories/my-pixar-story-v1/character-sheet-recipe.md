# Character sheet recipe — task procedure

The host agent reads the actual reference photos (rev 5) or the selected candidate image (rev <=4 legacy) and composes a prompt for that specific identity. Preserve face, age, hairline, eye color, body proportions, clothing, accessories and distinguishing traits from the approved references. Identity always matches the person and their photos (apply [C-IDENTITY]).

All character craft lives in `craft-guide.md#character-sheet` (with design rules in `#character-design`, `#prompt-rules` and `#identity`); apply its rules by ID instead of restating them.

Use Format B only: top row of four matching full-body neutral poses — front, three-quarter, profile, back — on one shared baseline (apply [R-SHEET-VIEWS]). Below: eight matching head/shoulder expression portraits in two rows of four, in the fixed order neutral, happy, delighted, sad, surprised, confused, angry, talking (apply [R-SHEET-EIGHT]). Name each expression explicitly in the authored prompt for the model — but the names must never be rendered as text in the image. Write the background as flat #B5B5B5 with the hex in every prompt (apply [R-SHEET-HEX]). No text, labels, captions, expression names or watermarks anywhere in the image (apply [R-SHEET-NO-TEXT]). Do not turn an expression change into a new age, hairstyle or outfit.

Send the reference images with this prompt to the image provider. A prompt that mentions an unseen sheet or character name is insufficient grounding. Always output the full prompt, every revision and every variation (apply [W-FULL-EVERY-TIME]). Review the resulting sheet for exact view/expression count, completeness, identity, anatomy, consistent outfit and recognizable acting. User approval follows the agent pass.
