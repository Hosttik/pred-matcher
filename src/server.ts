import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { syncAll } from "./service/sync.js";
import { MemoryStore } from "./service/store.js";
import type { Venue } from "./core/types.js";

const VERSION = "0.1.0";
const store = new MemoryStore();
let activeSync: Promise<unknown> | undefined;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function urlFor(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://localhost");
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = urlFor(request);

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok", version: VERSION, lastSync: store.getLastSync() ?? null });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/sync") {
    if (activeSync) {
      json(response, 409, { error: "sync_already_running" });
      return;
    }
    activeSync = syncAll(store);
    try {
      json(response, 200, await activeSync);
    } finally {
      activeSync = undefined;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/markets") {
    const venueParam = url.searchParams.get("venue");
    const venue = venueParam === "polymarket" || venueParam === "kalshi" ? venueParam as Venue : undefined;
    const markets = store.listMarkets(venue);
    json(response, 200, { count: markets.length, markets });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/relations") {
    const type = url.searchParams.get("type");
    const relations = store.listRelations().filter((relation) => !type || relation.type === type);
    json(response, 200, { count: relations.length, relations });
    return;
  }

  json(response, 404, { error: "not_found" });
}

export function createAppServer() {
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown_error";
      json(response, 500, { error: "internal_error", message });
    });
  });
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  createAppServer().listen(port, "0.0.0.0", () => {
    console.log(`pred-matcher v${VERSION} listening on :${port}`);
  });
}
