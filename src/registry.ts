/**
 * Service registry backed by KV.
 *
 * This is the cold path: only the admin API writes here, and the hot path reads
 * it once per request. That is well inside the Workers KV free-tier budget
 * (100k reads/day, 1k writes/day) because writes only happen on admin actions.
 */

import type { ServiceConfig } from "./types";

const INDEX_KEY = "services:index";

export async function listServices(kv: KVNamespace): Promise<ServiceConfig[]> {
  const ids = (await kv.get<string[]>(INDEX_KEY, "json")) ?? [];
  if (ids.length === 0) return [];
  const entries = await Promise.all(ids.map((id) => getService(kv, id)));
  return entries.filter((s): s is ServiceConfig => s !== null).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getService(kv: KVNamespace, id: string): Promise<ServiceConfig | null> {
  return await kv.get<ServiceConfig>(`service:${id}`, "json");
}

export async function putService(kv: KVNamespace, service: ServiceConfig): Promise<void> {
  const ids = (await kv.get<string[]>(INDEX_KEY, "json")) ?? [];
  if (!ids.includes(service.id)) {
    ids.push(service.id);
    ids.sort();
    await kv.put(INDEX_KEY, JSON.stringify(ids));
  }
  await kv.put(`service:${service.id}`, JSON.stringify(service));
}

export async function deleteService(kv: KVNamespace, id: string): Promise<boolean> {
  const ids = (await kv.get<string[]>(INDEX_KEY, "json")) ?? [];
  if (!ids.includes(id)) return false;
  await kv.put(
    INDEX_KEY,
    JSON.stringify(ids.filter((v) => v !== id))
  );
  await kv.delete(`service:${id}`);
  return true;
}

export const RESERVED_IDS = new Set(["admin", "api", "assets", "favicon.ico"]);

export function isValidServiceId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) && !RESERVED_IDS.has(id);
}
