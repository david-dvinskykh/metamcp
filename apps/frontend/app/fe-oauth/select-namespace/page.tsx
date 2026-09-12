"use client";

import { Namespace } from "@repo/zod-types";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useTranslations } from "@/hooks/useTranslations";
import { vanillaTrpcClient } from "@/lib/trpc";

/**
 * Namespace picker for the global MCP endpoint.
 *
 * The global endpoint has no namespace in its URL, so the client is told which
 * namespace to serve by the token it authorizes here. This page is the one
 * place the user makes that choice; the selection travels on to the OAuth
 * callback, which binds it to the authorization code.
 */
function NamespaceSelection() {
  const { t } = useTranslations();
  const searchParams = useSearchParams();
  const oauthParams = searchParams.get("params");

  const [namespaces, setNamespaces] = useState<Namespace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const loadNamespaces = async () => {
      try {
        const response =
          await vanillaTrpcClient.frontend.namespaces.list.query();
        setNamespaces(response.data);
      } catch {
        // Not signed in (or the session expired): come back here afterwards so
        // the authorization the user started can finish.
        const callbackUrl = `/fe-oauth/select-namespace?params=${encodeURIComponent(
          oauthParams ?? "",
        )}`;
        window.location.href = `/login?callbackUrl=${encodeURIComponent(
          callbackUrl,
        )}`;
      }
    };

    loadNamespaces();
  }, [oauthParams]);

  const connect = (namespaceUuid: string) => {
    if (!oauthParams) {
      setError(t("common:oauth.namespaceSelection.missingRequest"));
      return;
    }

    setSelected(namespaceUuid);
    window.location.href = `/oauth/callback?params=${encodeURIComponent(
      oauthParams,
    )}&namespace_uuid=${encodeURIComponent(namespaceUuid)}`;
  };

  if (!oauthParams) {
    return (
      <p className="text-sm text-destructive">
        {t("common:oauth.namespaceSelection.missingRequest")}
      </p>
    );
  }

  if (!namespaces) {
    return <p className="text-sm">{t("common:loading")}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">
          {t("common:oauth.namespaceSelection.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("common:oauth.namespaceSelection.description")}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {namespaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("common:oauth.namespaceSelection.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {namespaces.map((namespace) => (
            <li
              key={namespace.uuid}
              className="flex items-center justify-between gap-4 rounded-lg border p-4"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{namespace.name}</p>
                {namespace.description && (
                  <p className="truncate text-sm text-muted-foreground">
                    {namespace.description}
                  </p>
                )}
              </div>
              <Button
                onClick={() => connect(namespace.uuid)}
                disabled={selected !== null}
              >
                {selected === namespace.uuid
                  ? t("common:oauth.redirecting")
                  : t("common:oauth.namespaceSelection.connect")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoadingFallback() {
  const { t } = useTranslations();
  return <p className="text-sm">{t("common:loading")}</p>;
}

export default function SelectNamespacePage() {
  return (
    <div className="relative min-h-screen">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="mx-auto w-full max-w-xl px-6 py-16">
        <Suspense fallback={<LoadingFallback />}>
          <NamespaceSelection />
        </Suspense>
      </div>
    </div>
  );
}
