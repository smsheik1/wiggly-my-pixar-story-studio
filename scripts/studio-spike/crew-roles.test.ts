import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { StudioProduction } from "../../lib/studio-production.js";
import { provisionLocalOperator, signLocalOperator } from "../../lib/studio-operator.js";
import { loadMemoirFormat, createMemoirAssignment, assertCrewRole } from "./memoir-format.js";
import { capabilityDiagnosticsRoot } from "./rehearsal-capability.js";

test("memoir ticket with a made-up role is rejected", async () => {
  const kit = resolve(import.meta.dirname, "../../public/format-repositories/my-pixar-story-v1");
  const format = await loadMemoirFormat(kit);
  const root = mkdtempSync(join(tmpdir(), "wiggly-crew-roles-test-"));
  const store = new StudioProduction(root);
  const principal = provisionLocalOperator(root);
  const source = JSON.parse(readFileSync(join(kit, "examples/parent.json"), "utf8"));
  try {
    store.createProject("film", 0);
    store.authenticatedProjectCommand(signLocalOperator(root, { id: "resume-film", principal, project_id: "film", action: "resume" as const, value: 0, reason: "Isolated crew roles test" }));
    store.activateMemoirPolicy(signLocalOperator(root, { id: "film-policy", principal, project_id: "film", action: "activate_memoir_policy" as const, source_inputs: source }));

    const ticketId = "ticket-made-up-role";
    assert.throws(
      () => createMemoirAssignment(format, store, {
        id: ticketId,
        projectId: "film",
        kind: "answers",
        role: "capability-inspector",
        outcome: "Confirm the exact approved source answers without adding or paraphrasing facts.",
        inputs: {},
      }),
      /^Error: UNKNOWN_CREW_ROLE|UNKNOWN_CREW_ROLE: capability-inspector/
    );

    assert.throws(() => store.ticket(ticketId), /TICKET_NOT_FOUND/);

    assert.throws(() => assertCrewRole(format.config.agents, "toString"), /^Error: UNKNOWN_CREW_ROLE|UNKNOWN_CREW_ROLE: toString/);
    assert.doesNotThrow(() => assertCrewRole(format.config.agents, "script-writer"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("capability diagnostics root is not the rehearsal root", () => {
  const runId = "capability-test";
  const expected = resolve(import.meta.dirname, "output", "diagnostics", runId);
  const diagRoot = capabilityDiagnosticsRoot(runId);
  assert.equal(diagRoot, expected);

  const contains = (base: string, target: string) => {
    const distance = relative(base, target);
    return !distance || (!isAbsolute(distance) && distance !== ".." && !distance.startsWith(".." + sep));
  };

  const tmpRehearsal = mkdtempSync(join(tmpdir(), "wiggly-rehearsal-root-"));
  try {
    assert.notEqual(diagRoot, tmpRehearsal);
    assert.equal(contains(tmpRehearsal, diagRoot), false);
  } finally {
    rmSync(tmpRehearsal, { recursive: true, force: true });
  }

  const spikeDirRehearsal = resolve(import.meta.dirname, "output", "rehearsal");
  assert.notEqual(diagRoot, spikeDirRehearsal);
  assert.equal(contains(spikeDirRehearsal, diagRoot), false);

  assert.throws(() => capabilityDiagnosticsRoot(".."), /^Error: INVALID_DIAGNOSTICS_RUN_ID/);
  assert.throws(() => capabilityDiagnosticsRoot("a/b"), /^Error: INVALID_DIAGNOSTICS_RUN_ID/);
  assert.throws(() => capabilityDiagnosticsRoot(""), /^Error: INVALID_DIAGNOSTICS_RUN_ID/);
});
