import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioProduction, memoirFilmReviewCriteria } from "../../lib/studio-production.js";
import { provisionLocalOperator, signLocalOperator } from "../../lib/studio-operator.js";
import { hash } from "./harness.js";
import { startMemoirReview } from "./memoir-format.js";

function fixture(run: (store: StudioProduction) => void) {
  const root = mkdtempSync(join(tmpdir(), "wiggly-reviewer-identity-"));
  const store = new StudioProduction(root, () => 1000);
  const principal = provisionLocalOperator(root);
  try {
    store.createProject("film", 0);
    store.authenticatedProjectCommand(signLocalOperator(root, { id: "resume-mock", principal, project_id: "film", action: "resume" as const, value: 0, reason: "Explicit isolated fixture" }));
    store.activateMemoirPolicy(signLocalOperator(root, { id: "policy", principal, project_id: "film", action: "activate_memoir_policy" as const, source_inputs: { explicit_mock: true } }));
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function publish(store: StudioProduction, id: string, kind: string, criteria = ["continuity"]) {
  store.createTicket(id, "film", "artist", {}, 0);
  store.bindMemoirAssignment(id, kind, criteria);
  const lease = store.claim(id, `author-${id}`, 1000);
  const bytes = Buffer.from(`EXPLICIT MOCK ${id}`);
  writeFileSync(join(store.draftDirectory(lease), "candidate.json"), bytes);
  const evidence = store.mediaSupplied(lease, bytes, { runId: "mock", model: "mock", modality: "text", coverage: "complete" });
  store.inspectionCompleted(lease, evidence, "Explicit fixture author inspection; no creative-quality claim.");
  store.publish(lease, { draft_path: "candidate.json", evidence_references: [evidence], validated_hash: hash(bytes) });
}

test("memoir review for text modality assigns text-reviewer role", () => fixture(store => {
  publish(store, "author-script", "script");
  startMemoirReview(store, "author-script", "reviewer-script");
  const ticket = store.ticket("reviewer-script");
  assert.equal(ticket.role, "text-reviewer");
  assert.equal(ticket.kind, "REVIEWER");
}));

test("memoir review for audio modality assigns audio-reviewer role", () => fixture(store => {
  publish(store, "author-narration", "narration");
  startMemoirReview(store, "author-narration", "reviewer-narration");
  assert.equal(store.ticket("reviewer-narration").role, "audio-reviewer");

  publish(store, "author-audition", "audition");
  startMemoirReview(store, "author-audition", "reviewer-audition");
  assert.equal(store.ticket("reviewer-audition").role, "audio-reviewer");

  publish(store, "author-film-audio", "film", memoirFilmReviewCriteria.audio);
  startMemoirReview(store, "author-film-audio", "reviewer-film-audio", 0, "audio");
  assert.equal(store.ticket("reviewer-film-audio").role, "audio-reviewer");
}));

test("memoir review for visual modality assigns visual-reviewer role and rejects unknown role", () => fixture(store => {
  publish(store, "author-sheet", "sheet");
  startMemoirReview(store, "author-sheet", "reviewer-sheet");
  assert.equal(store.ticket("reviewer-sheet").role, "visual-reviewer");

  publish(store, "author-video", "video");
  startMemoirReview(store, "author-video", "reviewer-video");
  assert.equal(store.ticket("reviewer-video").role, "visual-reviewer");

  publish(store, "author-film-video", "film", memoirFilmReviewCriteria.video);
  startMemoirReview(store, "author-film-video", "reviewer-film-video", 0, "video");
  assert.equal(store.ticket("reviewer-film-video").role, "visual-reviewer");

  assert.throws(() => startMemoirReview(store, "author-film-video", "bad-review", 0, "unknown" as any), /UNKNOWN_REVIEWER_ROLE/);
}));
