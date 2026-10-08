import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StudioProduction } from "../../lib/studio-production.js";
import { provisionLocalOperator, signLocalOperator } from "../../lib/studio-operator.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";

test("stale lease sweep and recovery", async () => {
  const root = join(tmpdir(), "stale-lease-test-" + randomUUID());
  mkdirSync(root, { recursive: true });
  
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  const principal = provisionLocalOperator(root);
  
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  
  const assignment = store.claim("t1", "w1", 5000);
  assert.ok(assignment);
  assert.equal(assignment.ticketId, "t1");
  
  // 1. A live lease is untouched
  const tLive = store.ticket("t1");
  assert.equal(tLive.status, "WORKING");
  assert.ok(tLive.lease_until > now);
  const sweptLive = store.sweepStaleLeases();
  assert.equal(sweptLive.length, 0);
  
  // Fast forward time
  now = tLive.lease_until + 1000;
  
  // 2. lease 0 gets swept
  const sweptExpired = store.sweepStaleLeases();
  assert.equal(sweptExpired.length, 1);
  assert.equal(sweptExpired[0], "t1");
  
  const tSwept = store.ticket("t1");
  assert.equal(tSwept.status, "BLOCKED");
  assert.equal(tSwept.blocked_reason, "STALE_LEASE");
  assert.equal(tSwept.blocked_from, "WORKING");
  
  // 3. A swept ticket can't be claimed until recovery
  assert.throws(() => store.claim("t1", "w2", 5000), /TICKET_ALREADY_CLAIMED/);
  
  // 4. Recovery keeps attempt_id and turns
  const attemptId = tSwept.attempt_id;
  const turns = tSwept.revision;
  
  const command = signLocalOperator(root, {
    action: "extend_limits" as const,
    ticket_id: "t1",
    project_id: "p1",
    expected_revision: tSwept.revision,
    max_turns: tSwept.max_turns, // Not increasing limits
    principal,
    id: randomUUID(),
    reason: "recover lease"
  });
  
  store.authorizeLimits(command);
  
  const tRecovered = store.ticket("t1");
  assert.equal(tRecovered.status, "WORKING");
  assert.equal(tRecovered.attempt_id, attemptId);
  assert.equal(tRecovered.revision, turns + 1); // 1 for sweep, 1 for recovery
  
  store.close();
});
