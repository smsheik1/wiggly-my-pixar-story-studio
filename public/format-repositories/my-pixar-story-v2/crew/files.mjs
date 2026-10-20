// Prompt file names per crew member. Every agent's skill is crew/<agent>/role.md and its review rubric
// crew/<agent>/REVIEW.md, except where named here (the Story Director's files are numbered in the order they run).
export const CREW_FILES = Object.freeze({
  'story-director': Object.freeze({ skill: '3-script-writer.md', review: '4-script-review.md', storyPlan: '1-story-plan.md', storyCritique: '2-story-critique.md' }),
});
/** The agent's skill (writer prompt) file name inside crew/<agent>/. */
export const skillFileName = (agent) => CREW_FILES[agent]?.skill ?? 'role.md';
/** The agent's review rubric file name inside crew/<agent>/. */
export const reviewFileName = (agent) => CREW_FILES[agent]?.review ?? 'REVIEW.md';
