import { StudioProduction, type InputVersions, type TicketLimits } from "../../lib/studio-production.js";
import { assertCrewRole, type loadMemoirFormat } from "./memoir-format.js";

export const PRODUCTION_MANAGER_ROLE = "generation-planner" as const;
export type ProductionManagerPurpose = "quote" | "recovery-prep";

type Format = Awaited<ReturnType<typeof loadMemoirFormat>>;

export function createProductionManagerTicket(
  format: Format,
  store: StudioProduction,
  options: {
    id: string;
    projectId: string;
    purpose: ProductionManagerPurpose;
    inputs?: InputVersions;
    allowanceMicros?: number;
    limits?: Partial<TicketLimits>;
  }
) {
  if (options.purpose !== "quote" && options.purpose !== "recovery-prep") {
    throw new Error("INVALID_PRODUCTION_MANAGER_PURPOSE");
  }
  assertCrewRole(format.config.agents, PRODUCTION_MANAGER_ROLE);
  store.createTicket(
    options.id,
    options.projectId,
    PRODUCTION_MANAGER_ROLE,
    options.inputs ?? {},
    options.allowanceMicros ?? 0,
    "AUTHOR",
    options.limits ?? {}
  );
  return store.ticket(options.id);
}
