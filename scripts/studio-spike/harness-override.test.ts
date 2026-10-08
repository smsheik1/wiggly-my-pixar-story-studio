import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudioProduction, type WorkerLease } from "../../lib/studio-production.js";
import { provisionLocalOperator, signLocalOperator } from "../../lib/studio-operator.js";

function temp() { return mkdtempSync(join(tmpdir(), "wiggly-harness-")); }
async function isolated(run: (root: string) => Promise<void> | void) { const root = temp(); try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); } }

function setup(root: string) {
  const store = new StudioProduction(root, () => 1000);
  const principal = provisionLocalOperator(root);
  store.createProject("project", 1000000);
  store.operator("project", "resume", 0, { id: "resume", actor: principal, reason: "Isolated local test" });
  store.setInput("project", "script", "script-v1");
  store.createTicket("ticket", "project", "author", { script: "script-v1" }, 1000000);
  return { store, principal };
}

function inspect(store: StudioProduction, ctx: WorkerLease, file = "plate.txt", bytes = "DRAFT") {
  writeFileSync(join(store.draftDirectory(ctx), file), bytes);
  const evidence = store.mediaSupplied(ctx, Buffer.from(bytes), { runId: "mock", model: "mock", modality: "text", coverage: "complete" });
  store.inspectionCompleted(ctx, evidence, "Explicit mock inspection findings that are long enough.");
  return { draft_path: file, evidence_references: [evidence] };
}

test("unregistered worker cannot publish", async () => isolated(root => {
  const { store } = setup(root);
  store.registerCrewWorker("project", "author", "registered-other");
  store.registerCrewWorker("project", "reviewer", "unregistered-author");
  const ctx = store.claim("ticket", "unregistered-author", 1000);
  const candidate = inspect(store, ctx);
  assert.throws(() => store.publish(ctx, candidate), /UNREGISTERED_CREW_WORKER/);
  assert.equal(store.ticket("ticket").status, "WORKING");
  assert.equal(store.ticket("ticket").candidate_id, null);
}));

test("harness override is recorded and visible", async () => isolated(root => {
  const { store, principal } = setup(root);
  const ctx = store.claim("ticket", "unregistered", 1000);
  const candidate = inspect(store, ctx);

  // (a) a command signed for action "resume" but with harness_override fields passed to harnessOverride -> /INVALID_HARNESS_OVERRIDE/
  const cmdA = signLocalOperator(root, { id: "cmdA", principal, project_id: "project", action: "resume", ticket_id: "ticket", attempt_id: ctx.attemptId, reason: "Resume cmd" } as any);
  assert.throws(() => store.harnessOverride(cmdA), /INVALID_HARNESS_OVERRIDE/);

  // (b) a correctly-shaped command with a tampered signature -> /UNAUTHENTICATED_OPERATOR/
  const cmdB = signLocalOperator(root, { id: "cmdB", principal, project_id: "project", action: "harness_override", ticket_id: "ticket", attempt_id: ctx.attemptId, reason: "Valid reason for override" } as any);
  cmdB.signature += "tamper";
  assert.throws(() => store.harnessOverride(cmdB), /UNAUTHENTICATED_OPERATOR/);

  // (c) empty reason -> /INVALID_HARNESS_OVERRIDE/
  const cmdC = signLocalOperator(root, { id: "cmdC", principal, project_id: "project", action: "harness_override", ticket_id: "ticket", attempt_id: ctx.attemptId, reason: "short" } as any);
  assert.throws(() => store.harnessOverride(cmdC), /INVALID_HARNESS_OVERRIDE/);

  // (d) valid signed override -> harnessOverrides(ticket) has exactly 1 row with the reason, actor = principal, attempt_id = ctx.attemptId
  const cmdD = signLocalOperator(root, { id: "cmdD", principal, project_id: "project", action: "harness_override", ticket_id: "ticket", attempt_id: ctx.attemptId, reason: "Mechanical fallback override" } as any);
  store.harnessOverride(cmdD);
  const overrides = store.harnessOverrides("ticket");
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].reason, "Mechanical fallback override");
  assert.equal(overrides[0].actor, principal);
  assert.equal(overrides[0].attempt_id, ctx.attemptId);

  // (e) applying the SAME signed command again -> /HARNESS_OVERRIDE_REPLAY/ and still 1 row
  assert.throws(() => store.harnessOverride(cmdD), /HARNESS_OVERRIDE_REPLAY/);
  assert.equal(store.harnessOverrides("ticket").length, 1);

  // (f) now publish succeeds and ticket is SUBMITTED
  store.publish(ctx, candidate);
  assert.equal(store.ticket("ticket").status, "SUBMITTED");
}));

test("registered crew worker publishes normally", async () => isolated(async root => {
  const { store } = setup(root);
  store.registerCrewWorker("project", "author", "registered");
  const ctx = store.claim("ticket", "registered", 1000);
  store.publish(ctx, inspect(store, ctx));
  assert.equal(store.ticket("ticket").status, "SUBMITTED");
  assert.equal(store.harnessOverrides("ticket").length, 0);
  store.close();

  // Test idempotency
  const reopened = new StudioProduction(root, () => 1000);
  reopened.close();

  // Test upgrade from v5
  const rootV5 = temp();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(rootV5, "studio.sqlite"));
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      PRAGMA user_version = 5;
    `);
    db.close();
    const upgrader = new StudioProduction(rootV5, () => 1000);
    upgrader.close();
  } finally {
    rmSync(rootV5, { recursive: true, force: true });
  }
}));
