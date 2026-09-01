import http from "node:http";
import { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { InstagramWebLoginSession } from "./web-client";

/**
 * Instagram cannot be reached from CI, so the wire behaviour it enforces is
 * mimicked here: the login page issues a `csrftoken`, and the login endpoint
 * answers "CSRF token missing or incorrect" unless the request carries that
 * cookie back *and* repeats it in the X-CSRFToken header.
 *
 * This is the contract the client kept failing in the real world, so it is
 * pinned end to end rather than only at the response-parsing level.
 */

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let baseUrl: string;
const requests: RecordedRequest[] = [];
const ISSUED_CSRF = "issued-csrf-token";
const SHARED_DATA_CSRF = "shared-data-csrf-token";

/**
 * Knobs for the behaviours Instagram varies between clients: handing a script
 * the literal token "missing", and bouncing the login page through a redirect
 * that carries the cookies.
 */
const behaviour = {
  loginPageToken: ISSUED_CSRF as string | null,
  redirectLoginPage: false,
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body,
    });

    // A redirect that sets the device cookies on the way, as instagram.com does.
    if (req.url === "/accounts/login/" && behaviour.redirectLoginPage) {
      res.setHeader("Set-Cookie", [
        "mid=Zabc123; Path=/; Secure",
        "ig_did=1111-2222; Path=/; Secure; HttpOnly",
      ]);
      res.writeHead(302, { Location: "/accounts/login/?hl=en" });
      res.end();
      return;
    }

    // The login page hands out the anonymous cookie set, as instagram.com does.
    if (req.url?.startsWith("/accounts/login/")) {
      const cookies = [
        "mid=Zabc123; Path=/; Secure",
        "ig_did=1111-2222; Path=/; Secure; HttpOnly",
      ];
      if (behaviour.loginPageToken !== null) {
        cookies.unshift(
          `csrftoken=${behaviour.loginPageToken}; Path=/; Secure`,
        );
      }
      res.setHeader("Set-Cookie", cookies);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html></html>");
      return;
    }

    // The page config a browser would have had inlined.
    if (req.url?.startsWith("/data/shared_data/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ config: { csrf_token: SHARED_DATA_CSRF } }));
      return;
    }

    // Instagram's own check: the header must match the cookie it issued.
    const cookieHeader = req.headers.cookie ?? "";
    const cookieToken = /(?:^|;\s*)csrftoken=([^;]*)/.exec(cookieHeader)?.[1];
    const headerToken = req.headers["x-csrftoken"];
    if (!cookieToken || cookieToken !== headerToken) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          message: "CSRF token missing or incorrect",
          status: "fail",
        }),
      );
      return;
    }

    res.setHeader("Set-Cookie", [
      "sessionid=1234%3Asession%3Avalue; Path=/; Secure; HttpOnly",
      "ds_user_id=778899; Path=/; Secure",
      `csrftoken=${ISSUED_CSRF}; Path=/; Secure`,
    ]);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        authenticated: true,
        user: true,
        userId: "778899",
        status: "ok",
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("InstagramWebLoginSession against an Instagram-shaped server", () => {
  beforeEach(() => {
    requests.length = 0;
    behaviour.loginPageToken = ISSUED_CSRF;
    behaviour.redirectLoginPage = false;
  });

  it("carries the issued CSRF token in both the cookie and the header", async () => {
    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();
    const outcome = await session.login("someone", "hunter2");

    expect(outcome).toMatchObject({
      kind: "AUTHENTICATED",
      cookies: {
        sessionId: "1234%3Asession%3Avalue",
        csrfToken: ISSUED_CSRF,
        dsUserId: "778899",
      },
    });

    const post = requests.find((entry) => entry.method === "POST");
    expect(post).toBeDefined();
    expect(post?.headers["x-csrftoken"]).toBe(ISSUED_CSRF);
    expect(post?.headers.cookie).toContain(`csrftoken=${ISSUED_CSRF}`);
    // Every cookie the login page set has to come back, not just the token:
    // Instagram ties the token to the device cookies issued alongside it.
    expect(post?.headers.cookie).toContain("mid=Zabc123");
    expect(post?.headers.cookie).toContain("ig_did=1111-2222");
  });

  it("sends the password in Instagram's enc_password envelope", async () => {
    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();
    await session.login("someone", "hunter2");

    const post = requests.find((entry) => entry.method === "POST");
    const fields = new URLSearchParams(post?.body ?? "");
    expect(fields.get("username")).toBe("someone");
    expect(fields.get("enc_password")).toMatch(
      /^#PWD_INSTAGRAM_BROWSER:0:\d+:hunter2$/,
    );
  });

  it("points at the cookie path when Instagram rejects the token", async () => {
    // No prepare(): no cookie, so the server answers the way Instagram does
    // when the token never made it into the request.
    const session = new InstagramWebLoginSession({ baseUrl });
    const outcome = await session.login("someone", "hunter2");

    expect(outcome).toMatchObject({ kind: "ERROR" });
    expect((outcome as { message: string }).message).toContain(
      "cookie paste option",
    );
  });

  it("replaces the placeholder token Instagram gives a script", async () => {
    // `csrftoken=missing` is what produced "CSRF token missing or incorrect"
    // in the field: sent back verbatim, Instagram rejects it.
    behaviour.loginPageToken = "missing";

    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();
    const outcome = await session.login("someone", "hunter2");

    expect(outcome).toMatchObject({ kind: "AUTHENTICATED" });
    const post = requests.find((entry) => entry.method === "POST");
    expect(post?.headers["x-csrftoken"]).toBe(SHARED_DATA_CSRF);
    expect(post?.headers.cookie).toContain(`csrftoken=${SHARED_DATA_CSRF}`);
  });

  it("falls back to the page config when no token cookie is set at all", async () => {
    behaviour.loginPageToken = null;

    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();

    expect(
      requests.some((entry) => entry.url.startsWith("/data/shared_data/")),
    ).toBe(true);
    await expect(session.login("someone", "hunter2")).resolves.toMatchObject({
      kind: "AUTHENTICATED",
    });
  });

  it("keeps cookies set on a redirect hop of the login page", async () => {
    behaviour.redirectLoginPage = true;

    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();
    await session.login("someone", "hunter2");

    const post = requests.find((entry) => entry.method === "POST");
    // `mid` and `ig_did` were only ever set on the 302, which fetch would have
    // hidden had the redirect been followed by the runtime.
    expect(post?.headers.cookie).toContain("mid=Zabc123");
    expect(post?.headers.cookie).toContain("ig_did=1111-2222");
    expect(post?.headers["x-csrftoken"]).toBe(ISSUED_CSRF);
  });

  it("loads the login page as a navigation, not as an XHR", async () => {
    const session = new InstagramWebLoginSession({ baseUrl });
    await session.prepare();

    const page = requests.find((entry) =>
      entry.url.startsWith("/accounts/login/"),
    );
    // Sending these on the page load is what makes Instagram answer a script
    // with a placeholder token instead of a real one.
    expect(page?.headers["x-requested-with"]).toBeUndefined();
    expect(page?.headers["x-ig-app-id"]).toBeUndefined();
    expect(page?.headers.accept).toContain("text/html");
  });
});
