import type { Config } from "@netlify/functions";
import { handle } from "../../server/routes.ts";

export default (request: Request) => handle(request);

export const config: Config = { path: "/api/*" };
