import { test } from "node:test";
import { strict as assert } from "node:assert";
import { StudioProduction } from "../../lib/studio-production.js";
import { provisionLocalOperator, signLocalOperator } from "../../lib/studio-operator.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("a WORKING ticket with an expired lease gets swept", async () => {
  const root = join(tmpdir(), "stale-lease-test-a-" + randomUUID());
  mkdirSync(root, { recursive: true });
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  const lease = (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w1"),store.claim("t1", "w1", 5000));
  assert.ok(lease);

  // Expire the lease
  now = 7000;
  const swept = store.sweepStaleLeases();
  assert.deepEqual(swept, ["t1"]);

  const t = store.ticket("t1");
  assert.equal(t.status, "BLOCKED");
  assert.equal(t.blocked_reason, "STALE_LEASE");
  assert.equal(t.blocked_from, "WORKING");

  const db = new DatabaseSync(join(root, "studio.sqlite"));
  const decisions = db.prepare("SELECT * FROM operator_decisions WHERE action='sweep_stale'").all() as any[];
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].actor, "studio-startup");
  assert.equal(decisions[0].action, "sweep_stale");
  assert.equal(decisions[0].value, 0);
  assert.equal(decisions[0].reason, "t1");
  db.close();
  store.close();
});

test("a live lease is untouched by the sweep", async () => {
  const root = join(tmpdir(), "stale-lease-test-b-" + randomUUID());
  mkdirSync(root, { recursive: true });
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  const lease = (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w1"),store.claim("t1", "w1", 5000));
  assert.ok(lease);

  // Still active lease (now is 1000, lease until 6000)
  const swept = store.sweepStaleLeases();
  assert.deepEqual(swept, []);

  const t = store.ticket("t1");
  assert.equal(t.status, "WORKING");
  assert.equal(t.blocked_reason, null);

  store.close();
});

test("a swept ticket can't be claimed (TICKET_ALREADY_CLAIMED)", async () => {
  const root = join(tmpdir(), "stale-lease-test-c-" + randomUUID());
  mkdirSync(root, { recursive: true });
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w1"),store.claim("t1", "w1", 5000));

  now = 7000;
  store.sweepStaleLeases();

  assert.throws(() => (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w2"),store.claim("t1", "w2", 5000)), /TICKET_ALREADY_CLAIMED/);
  store.close();
});

test("signed recovery keeps attempt_id AND the real worker_turns rows", async () => {
  const root = join(tmpdir(), "stale-lease-test-d-" + randomUUID());
  mkdirSync(root, { recursive: true });
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  const principal = provisionLocalOperator(root);
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  const lease = (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w1"),store.claim("t1", "w1", 5000));

  // Record at least one real turn before lease expires
  store.beginTurn(lease, "turn-1");
  store.beginTurn(lease, "turn-2");

  const db = new DatabaseSync(join(root, "studio.sqlite"));
  const turnsBefore = db.prepare("SELECT COUNT(*) AS count FROM worker_turns WHERE ticket_id=? AND attempt_id=?").get("t1", lease.attemptId) as { count: number };
  assert.ok(turnsBefore.count > 0, "must have recorded real turns");

  // Expire and sweep
  now = 7000;
  store.sweepStaleLeases();
  const sweptTicket = store.ticket("t1");
  assert.equal(sweptTicket.status, "BLOCKED");

  // Sign and execute recovery
  const command = signLocalOperator(root, {
    action: "extend_limits" as const,
    ticket_id: "t1",
    project_id: "p1",
    expected_revision: sweptTicket.revision,
    principal,
    id: randomUUID(),
    reason: "recover stale lease"
  });
  store.authorizeLimits(command);

  const recoveredTicket = store.ticket("t1");
  assert.equal(recoveredTicket.status, "WORKING");
  assert.equal(recoveredTicket.attempt_id, lease.attemptId);

  const turnsAfter = db.prepare("SELECT COUNT(*) AS count FROM worker_turns WHERE ticket_id=? AND attempt_id=?").get("t1", lease.attemptId) as { count: number };
  assert.equal(turnsAfter.count, turnsBefore.count);
  assert.ok(turnsAfter.count > 0);

  db.close();
  store.close();
});

test("after recovery, calling sweepStaleLeases() again sweeps nothing, and a NEW worker can claim the ticket and gets the same attempt_id", async () => {
  const root = join(tmpdir(), "stale-lease-test-e-" + randomUUID());
  mkdirSync(root, { recursive: true });
  let now = 1000;
  const store = new StudioProduction(root, () => now);
  const principal = provisionLocalOperator(root);
  store.createProject("p1", 1000000);
  store.operator("p1", "resume", 0, { id: randomUUID(), actor: "test", reason: "start" });
  store.setInput("p1", "asset", "v1");
  store.createTicket("t1", "p1", "my-role", { asset: "v1" }, 1000000);
  const lease1 = (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w1"),store.claim("t1", "w1", 5000));

  now = 7000;
  store.sweepStaleLeases();

  const sweptTicket = store.ticket("t1");
  const command = signLocalOperator(root, {
    action: "extend_limits" as const,
    ticket_id: "t1",
    project_id: "p1",
    expected_revision: sweptTicket.revision,
    principal,
    id: randomUUID(),
    reason: "recover stale lease"
  });
  store.authorizeLimits(command);

  // Calling sweepStaleLeases() again sweeps nothing
  const sweptAgain = store.sweepStaleLeases();
  assert.deepEqual(sweptAgain, []);

  // A NEW worker can claim the ticket and gets the same attempt_id
  const lease2 = (store.ticket("t1").kind==='AUTHOR'&&store.registerCrewWorker(store.ticket("t1").project_id,store.ticket("t1").role, "w2"),store.claim("t1", "w2", 5000));
  assert.ok(lease2);
  assert.equal(lease2.workerId, "w2");
  assert.equal(lease2.attemptId, lease1.attemptId);

  const currentTicket = store.ticket("t1");
  assert.equal(currentTicket.status, "WORKING");
  assert.equal(currentTicket.worker_id, "w2");
  assert.equal(currentTicket.attempt_id, lease1.attemptId);

  store.close();
});
