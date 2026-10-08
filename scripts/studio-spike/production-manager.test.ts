import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StudioProduction } from "../../lib/studio-production.js";
import { loadMemoirFormat } from "./memoir-format.js";
import { createProductionManagerTicket, PRODUCTION_MANAGER_ROLE } from "./production-manager.js";

test("production manager tickets bind generation-planner (Max) for quote and recovery-prep", async () => {
  const kit = resolve(import.meta.dirname, "../../public/format-repositories/my-pixar-story-v1");
  const format = await loadMemoirFormat(kit);
  const root = mkdtempSync(join(tmpdir(), "wiggly-production-manager-test-"));
  const store = new StudioProduction(root);
  try {
    store.createProject("film", 0);

    assert.equal(format.config.agents["generation-planner"].name, "Max");

    const quoteTicket = createProductionManagerTicket(format, store, {
      id: "ticket-quote",
      projectId: "film",
      purpose: "quote",
    });
    assert.equal(quoteTicket.role, "generation-planner");
    assert.equal(quoteTicket.role, PRODUCTION_MANAGER_ROLE);
    assert.equal(quoteTicket.kind, "AUTHOR");

    const recoveryTicket = createProductionManagerTicket(format, store, {
      id: "ticket-recovery",
      projectId: "film",
      purpose: "recovery-prep",
    });
    assert.equal(recoveryTicket.role, "generation-planner");
    assert.equal(recoveryTicket.role, PRODUCTION_MANAGER_ROLE);

    assert.throws(
      () =>
        createProductionManagerTicket(format, store, {
          id: "ticket-approve",
          projectId: "film",
          purpose: "approve" as any,
        }),
      /INVALID_PRODUCTION_MANAGER_PURPOSE/
    );
    assert.throws(() => store.ticket("ticket-approve"), /TICKET_NOT_FOUND/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
