import { env } from "cloudflare:workers";
import { handleStudio, type StudioConfig } from "../../../studio-api";

export function GET(request: Request) {
  return handleStudio(request, env as StudioConfig, { development: import.meta.env.DEV });
}
export const POST = GET;
