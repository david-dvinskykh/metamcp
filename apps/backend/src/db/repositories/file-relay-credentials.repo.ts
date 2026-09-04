import { and, eq } from "drizzle-orm";

import { db } from "../index";
import { fileRelayCredentialsTable } from "../schema";

export type FileRelayProvider = "TELEGRAM_BOT" | "GOOGLE_DRIVE";

export interface FileRelayCredentialRow {
  uuid: string;
  user_id: string;
  provider: FileRelayProvider;
  payload: Record<string, unknown>;
  label: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Per-user credentials for the file relay.
 *
 * Every read is keyed by user id: there is deliberately no "find by provider"
 * that could hand one user's grant to another's request.
 */
export const fileRelayCredentialsRepository = {
  /** The user's connection for one provider, secrets included. */
  async find(
    userId: string,
    provider: FileRelayProvider,
  ): Promise<FileRelayCredentialRow | undefined> {
    const [row] = await db
      .select()
      .from(fileRelayCredentialsTable)
      .where(
        and(
          eq(fileRelayCredentialsTable.user_id, userId),
          eq(fileRelayCredentialsTable.provider, provider),
        ),
      )
      .limit(1);
    return row as FileRelayCredentialRow | undefined;
  },

  /** Every connection the user has, for the settings page. */
  async listForUser(userId: string): Promise<FileRelayCredentialRow[]> {
    return (await db
      .select()
      .from(fileRelayCredentialsTable)
      .where(
        eq(fileRelayCredentialsTable.user_id, userId),
      )) as FileRelayCredentialRow[];
  },

  /** Connect or reconnect: one row per user per provider. */
  async upsert(input: {
    userId: string;
    provider: FileRelayProvider;
    payload: Record<string, unknown>;
    label?: string | null;
  }): Promise<FileRelayCredentialRow> {
    const [row] = await db
      .insert(fileRelayCredentialsTable)
      .values({
        user_id: input.userId,
        provider: input.provider,
        payload: input.payload,
        label: input.label ?? null,
      })
      .onConflictDoUpdate({
        target: [
          fileRelayCredentialsTable.user_id,
          fileRelayCredentialsTable.provider,
        ],
        set: {
          payload: input.payload,
          label: input.label ?? null,
          updated_at: new Date(),
        },
      })
      .returning();
    return row as FileRelayCredentialRow;
  },

  /** Disconnect. Scoped to the owner, so it cannot remove someone else's. */
  async remove(userId: string, provider: FileRelayProvider): Promise<boolean> {
    const removed = await db
      .delete(fileRelayCredentialsTable)
      .where(
        and(
          eq(fileRelayCredentialsTable.user_id, userId),
          eq(fileRelayCredentialsTable.provider, provider),
        ),
      )
      .returning();
    return removed.length > 0;
  },
};
