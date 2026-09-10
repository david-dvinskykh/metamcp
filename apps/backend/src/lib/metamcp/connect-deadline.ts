import logger from "@/utils/logger";

/**
 * How long one backend server may take to hand back a session before the
 * namespace stops waiting for it.
 *
 * A namespace fan-out (tools/list, prompts/list, resources/list, and the map
 * rebuild behind tools/call) asks every server in the namespace for a session
 * and awaits them together. `Promise.allSettled` bounds nothing: a settled
 * promise is one that finished, and a backend that accepts the spawn and then
 * never completes the MCP handshake never finishes. The pool retries such a
 * server up to MCP_MAX_ATTEMPTS times before giving up, so one unreachable
 * backend held the whole namespace's tool list for minutes — long past the
 * point where the calling client had timed out and every other server in that
 * namespace, healthy or not, had gone missing with it.
 *
 * The fan-out already knows what to do with a server that has no session: it
 * logs the server as failed and leaves it out of the response. This just makes
 * "took far too long" reach that path instead of blocking behind it.
 */
const DEFAULT_SERVER_SESSION_DEADLINE_MS = 30_000;

export const serverSessionDeadlineMs = (): number => {
  const configured = parseInt(
    process.env.NAMESPACE_SERVER_SESSION_TIMEOUT_MS || "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SERVER_SESSION_DEADLINE_MS;
};

/**
 * Await `work`, giving up after the namespace deadline and resolving to
 * `undefined` instead.
 *
 * The underlying promise is left running rather than cancelled: it is the pool
 * filling a connection that the next request will reuse, and dropping it would
 * mean starting over every time. Its result and its failure are both absorbed
 * here so a late rejection cannot surface as an unhandled one.
 */
export const withServerSessionDeadline = async <T>(
  label: string,
  work: Promise<T>,
): Promise<T | undefined> => {
  const deadline = serverSessionDeadlineMs();
  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logger.error(
        `Namespace fan-out gave up waiting for ${label} after ${deadline}ms; ` +
          `it is excluded from this response while the pool keeps connecting`,
      );
      resolve(undefined);
    }, deadline);
  });

  try {
    return await Promise.race([
      work.catch((error) => {
        logger.error(`Failed to get a session for ${label}:`, error);
        return undefined;
      }),
      expired,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
