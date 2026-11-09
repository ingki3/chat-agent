import { z } from "zod";

/** Response of `GET /api/health`. Shared by server and web so both sides agree on the shape. */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.literal("agent-lee"),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const SERVICE_NAME = "Agent Lee";

export const broken: number = "not a number";
