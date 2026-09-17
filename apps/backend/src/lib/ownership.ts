/**
 * Who a created or updated resource may belong to.
 *
 * The frontend routers take `user_id` in the request body: the UI uses it to
 * say "public" (null) and, for a resource it is editing, to keep the owner it
 * already has. Nothing in the routers checked that a *named* owner is the
 * caller, so any signed-in user could post another user's id and plant a
 * server, namespace, endpoint or API key inside that account -- a Telegram
 * connector dropped into someone else's account carries their session, which
 * is the whole account.
 *
 * So: absent means "mine" (or, on an update, "leave it alone"), null means
 * public, the caller's own id is fine, and anything else is refused. Public
 * stays open to every user because that is what the sharing toggle in the UI
 * does -- it exposes the caller's own resource, not somebody else's.
 */

export type OwnershipDecision =
  | { ok: true; userId: string | null }
  | { ok: false; message: string };

const FOREIGN_OWNER_MESSAGE =
  "Access denied: you can only create or update resources in your own account";

export function resolveOwnership(
  requested: string | null | undefined,
  callerId: string,
  fallback: string | null = callerId,
): OwnershipDecision {
  if (requested === undefined) {
    return { ok: true, userId: fallback };
  }
  if (requested === null) {
    return { ok: true, userId: null };
  }
  if (requested === callerId) {
    return { ok: true, userId: callerId };
  }
  return { ok: false, message: FOREIGN_OWNER_MESSAGE };
}
