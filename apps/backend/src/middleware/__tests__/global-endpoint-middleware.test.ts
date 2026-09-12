import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

type NamespaceRow = { uuid: string; user_id: string | null } | undefined;

let namespaceRow: NamespaceRow;

vi.mock("../../db/repositories/namespaces.repo", () => ({
  namespacesRepository: {
    findByUuid: async (uuid: string) =>
      namespaceRow && namespaceRow.uuid === uuid ? namespaceRow : undefined,
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { bindNamespaceFromToken, prepareGlobalEndpoint } =
  await import("../global-endpoint-middleware");

type TestRequest = express.Request & {
  oauthNamespaceUuid?: string;
  oauthUserId?: string;
  namespaceUuid?: string;
  endpoint?: { namespace_uuid: string };
};

function makeResponse() {
  const result: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  } as unknown as express.Response;

  return { res, result };
}

describe("bindNamespaceFromToken", () => {
  beforeEach(() => {
    namespaceRow = { uuid: "ns-1", user_id: "user-1" };
  });

  it("serves the namespace the token was issued for", async () => {
    const req = {
      oauthNamespaceUuid: "ns-1",
      oauthUserId: "user-1",
    } as TestRequest;
    const { res, result } = makeResponse();
    const next = vi.fn();

    await bindNamespaceFromToken(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(result.status).toBeUndefined();
    expect(req.namespaceUuid).toBe("ns-1");
    expect(req.endpoint?.namespace_uuid).toBe("ns-1");
  });

  it("also serves a public namespace", async () => {
    namespaceRow = { uuid: "ns-1", user_id: null };
    const req = {
      oauthNamespaceUuid: "ns-1",
      oauthUserId: "someone-else",
    } as TestRequest;
    const { res } = makeResponse();
    const next = vi.fn();

    await bindNamespaceFromToken(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("refuses a token that names no namespace", async () => {
    const req = { oauthUserId: "user-1" } as TestRequest;
    const { res, result } = makeResponse();
    const next = vi.fn();

    await bindNamespaceFromToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "namespace_not_selected" });
  });

  it("refuses a namespace that has since been deleted", async () => {
    namespaceRow = undefined;
    const req = {
      oauthNamespaceUuid: "ns-gone",
      oauthUserId: "user-1",
    } as TestRequest;
    const { res, result } = makeResponse();
    const next = vi.fn();

    await bindNamespaceFromToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "namespace_not_found" });
  });

  it("refuses a namespace that now belongs to someone else", async () => {
    namespaceRow = { uuid: "ns-1", user_id: "another-user" };
    const req = {
      oauthNamespaceUuid: "ns-1",
      oauthUserId: "user-1",
    } as TestRequest;
    const { res, result } = makeResponse();
    const next = vi.fn();

    await bindNamespaceFromToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: "access_denied" });
  });
});

describe("prepareGlobalEndpoint", () => {
  it("describes how to authenticate before any namespace is known", () => {
    const req = {} as TestRequest;
    const { res } = makeResponse();
    const next = vi.fn();

    prepareGlobalEndpoint(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.endpoint).toMatchObject({
      enable_oauth: true,
      enable_api_key_auth: false,
    });
  });
});
