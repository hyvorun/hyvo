import { CloneProfile, type CloneView } from "@hyvo/schema";
import { iso } from "./clock";
import { ApiError } from "./errors";

export interface CloneRow {
  address: string;
  status: "building" | "ready" | "failed";
  profile_json: string | null;
  error: string | null;
  run_id: string;
  created_at: number;
  updated_at: number;
}

export function findClone(db: D1Database, address: string): Promise<CloneRow | null> {
  return db.prepare("SELECT * FROM clones WHERE address = ?").bind(address.toLowerCase()).first<CloneRow>();
}

export function cloneView(row: CloneRow): CloneView {
  return {
    status: row.status,
    profile: row.profile_json ? CloneProfile.parse(JSON.parse(row.profile_json)) : null,
    failReason: row.status === "failed" ? row.error : null,
    updatedAt: iso(row.updated_at),
  };
}

/** The numbers a run plays: this wallet's own, and only once they are built. */
export async function readyProfile(db: D1Database, address: string): Promise<CloneProfile> {
  const row = await findClone(db, address);
  if (row?.status !== "ready" || !row.profile_json) throw new ApiError(409, "no_clone", "this wallet has no clone ready; build one first");
  return CloneProfile.parse(JSON.parse(row.profile_json));
}
