// Brand / proper names as the voice engine should say them. Written-form -> spoken spelling, applied to the sent prompt
// (spoken lines included) so in-render TTS pronounces them right. Add entries as renders reveal mispronunciations.
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
export const SPOKEN_SPELLINGS = Object.freeze({
  [b64('WXVnaW9o')]: b64('WXUtR2ktT2g='),
  [b64('WXUgR2kgT2g=')]: b64('WXUtR2ktT2g='),
});
