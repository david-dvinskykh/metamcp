"use client";

import {
  TELEGRAM_MCP_DEFAULT_COMMAND,
  TELEGRAM_MCP_DEFAULT_SERVER_NAME,
  TelegramLoginState,
} from "@repo/zod-types";
import {
  ChevronDown,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/hooks/useTranslations";
import { trpc } from "@/lib/trpc";

/** How often we ask the backend to advance the login while the QR is up. */
const POLL_INTERVAL_MS = 2000;

type Step = "credentials" | "qr" | "password" | "confirm";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Human label for the account we logged in as. */
function describeAccount(state: TelegramLoginState): string {
  const account = state.account;
  if (!account) return "";
  if (account.username) return `@${account.username}`;
  const name = [account.first_name, account.last_name]
    .filter(Boolean)
    .join(" ");
  return name || account.phone || account.id;
}

export function TelegramConnectorButton() {
  const { t } = useTranslations();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("credentials");
  const [error, setError] = useState<string | null>(null);

  // Step 1 — connector settings and Telegram API credentials
  const [serverName, setServerName] = useState(
    TELEGRAM_MCP_DEFAULT_SERVER_NAME,
  );
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [command, setCommand] = useState(TELEGRAM_MCP_DEFAULT_COMMAND);
  const [isPublic, setIsPublic] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Step 3 — cloud password (2FA)
  const [password, setPassword] = useState("");

  const [loginState, setLoginState] = useState<TelegramLoginState | null>(null);
  const loginIdRef = useRef<string | null>(null);
  const pollInFlight = useRef(false);

  const startLogin = trpc.frontend.telegram.startLogin.useMutation();
  const pollLogin = trpc.frontend.telegram.getLoginState.useMutation();
  const submitPassword = trpc.frontend.telegram.submitPassword.useMutation();
  const cancelLogin = trpc.frontend.telegram.cancelLogin.useMutation();
  const createServer = trpc.frontend.telegram.createServer.useMutation();

  const applyState = useCallback((state: TelegramLoginState) => {
    setLoginState(state);
    loginIdRef.current = state.login_id;
    setStep(
      state.phase === "AUTHENTICATED"
        ? "confirm"
        : state.phase === "AWAITING_PASSWORD"
          ? "password"
          : "qr",
    );
  }, []);

  const resetWizard = useCallback(() => {
    setStep("credentials");
    setError(null);
    setPassword("");
    setLoginState(null);
    loginIdRef.current = null;
  }, []);

  // Each poll advances the login server-side: it refreshes an expired QR, or
  // completes the login once Telegram reports the code was scanned. Kept in a
  // ref so the interval below survives re-renders instead of being torn down
  // and restarted by every changing mutation/translation identity.
  const poll = async () => {
    const loginId = loginIdRef.current;
    if (!loginId || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const response = await pollLogin.mutateAsync({ login_id: loginId });
      if (loginIdRef.current !== loginId) return;
      if (response.success && response.data) {
        applyState(response.data);
      } else {
        // The login cannot recover — drop it server-side and start over.
        setError(response.message ?? t("mcp-servers:telegram.loginFailed"));
        setStep("credentials");
        loginIdRef.current = null;
        cancelLogin.mutate({ login_id: loginId });
      }
    } catch (pollError) {
      setError(
        pollError instanceof Error
          ? pollError.message
          : t("mcp-servers:telegram.loginFailed"),
      );
    } finally {
      pollInFlight.current = false;
    }
  };

  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });

  useEffect(() => {
    if (step !== "qr") return;
    const timer = setInterval(() => {
      void pollRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [step]);

  const closeDialog = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) return;
      const loginId = loginIdRef.current;
      loginIdRef.current = null;
      if (loginId) {
        // Free the MTProto connection the abandoned login is holding.
        cancelLogin.mutate({ login_id: loginId });
      }
      resetWizard();
    },
    [cancelLogin, resetWizard],
  );

  const handleStart = async () => {
    setError(null);

    if (!SERVER_NAME_PATTERN.test(serverName) || /_{2,}/.test(serverName)) {
      setError(t("mcp-servers:telegram.invalidName"));
      return;
    }
    const parsedApiId = Number(apiId.trim());
    if (!Number.isInteger(parsedApiId) || parsedApiId <= 0) {
      setError(t("mcp-servers:telegram.invalidApiId"));
      return;
    }
    if (!/^[0-9a-fA-F]{32}$/.test(apiHash.trim())) {
      setError(t("mcp-servers:telegram.invalidApiHash"));
      return;
    }

    try {
      const response = await startLogin.mutateAsync({
        api_id: parsedApiId,
        api_hash: apiHash.trim(),
      });
      if (response.success && response.data) {
        applyState(response.data);
      } else {
        setError(response.message ?? t("mcp-servers:telegram.loginFailed"));
      }
    } catch (startError) {
      setError(
        startError instanceof Error
          ? startError.message
          : t("mcp-servers:telegram.loginFailed"),
      );
    }
  };

  const handlePassword = async () => {
    const loginId = loginIdRef.current;
    if (!loginId) return;
    setError(null);
    try {
      const response = await submitPassword.mutateAsync({
        login_id: loginId,
        password,
      });
      if (response.success && response.data) {
        setPassword("");
        applyState(response.data);
      } else {
        setError(response.message ?? t("mcp-servers:telegram.loginFailed"));
      }
    } catch (passwordError) {
      setError(
        passwordError instanceof Error
          ? passwordError.message
          : t("mcp-servers:telegram.loginFailed"),
      );
    }
  };

  const handleCreate = async () => {
    const loginId = loginIdRef.current;
    if (!loginId) return;
    setError(null);
    try {
      const response = await createServer.mutateAsync({
        login_id: loginId,
        name: serverName,
        command: command.trim() || TELEGRAM_MCP_DEFAULT_COMMAND,
        user_id: isPublic ? null : undefined,
      });
      if (response.success) {
        // The login is spent server-side; do not try to cancel it on close.
        loginIdRef.current = null;
        utils.frontend.mcpServers.list.invalidate();
        toast.success(t("mcp-servers:telegram.created"));
        closeDialog(false);
      } else {
        setError(response.message ?? t("mcp-servers:createError"));
      }
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : t("mcp-servers:createError"),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={closeDialog}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Send className="mr-2 h-4 w-4" />
          {t("mcp-servers:telegram.connect")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("mcp-servers:telegram.title")}</DialogTitle>
          <DialogDescription>
            {t("mcp-servers:telegram.description")}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-destructive break-words">{error}</p>
        )}

        {step === "credentials" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="telegram-server-name">
                {t("mcp-servers:name")}
              </Label>
              <Input
                id="telegram-server-name"
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                placeholder={TELEGRAM_MCP_DEFAULT_SERVER_NAME}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegram-api-id">
                {t("mcp-servers:telegram.apiId")}
              </Label>
              <Input
                id="telegram-api-id"
                value={apiId}
                onChange={(event) => setApiId(event.target.value)}
                placeholder="1234567"
                inputMode="numeric"
                autoComplete="off"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="telegram-api-hash">
                {t("mcp-servers:telegram.apiHash")}
              </Label>
              <Input
                id="telegram-api-hash"
                value={apiHash}
                onChange={(event) => setApiHash(event.target.value)}
                placeholder="0123456789abcdef0123456789abcdef"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {t("mcp-servers:telegram.credentialsHelp")}{" "}
                <a
                  className="underline inline-flex items-center gap-1"
                  href="https://my.telegram.org/apps"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  my.telegram.org/apps
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t("mcp-servers:ownership")}</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-between">
                    {isPublic
                      ? t("mcp-servers:public")
                      : t("mcp-servers:private")}
                    <ChevronDown className="ml-2 h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[var(--radix-dropdown-menu-trigger-width)]"
                  align="start"
                >
                  <DropdownMenuItem onClick={() => setIsPublic(false)}>
                    {t("mcp-servers:private")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setIsPublic(true)}>
                    {t("mcp-servers:public")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <p className="text-xs text-muted-foreground">
                {t("mcp-servers:ownershipHelp")}
              </p>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                className="text-xs text-muted-foreground underline"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                {t("mcp-servers:telegram.advanced")}
              </button>
              {showAdvanced && (
                <div className="space-y-2">
                  <Label htmlFor="telegram-command">
                    {t("mcp-servers:command")}
                  </Label>
                  <Input
                    id="telegram-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder={TELEGRAM_MCP_DEFAULT_COMMAND}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("mcp-servers:telegram.commandHelp")}
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => closeDialog(false)}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleStart}
                disabled={startLogin.isPending}
              >
                {startLogin.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("mcp-servers:telegram.getQr")}
              </Button>
            </div>
          </div>
        )}

        {step === "qr" && (
          <div className="space-y-4">
            <div className="flex justify-center">
              {loginState?.qr_image ? (
                <Image
                  src={loginState.qr_image}
                  alt={t("mcp-servers:telegram.qrAlt")}
                  width={256}
                  height={256}
                  unoptimized
                  className="rounded-lg bg-white p-3"
                />
              ) : (
                <div className="flex h-[280px] w-[280px] items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("mcp-servers:telegram.stepOpen")}</li>
              <li>{t("mcp-servers:telegram.stepDevices")}</li>
              <li>{t("mcp-servers:telegram.stepScan")}</li>
            </ol>

            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              {t("mcp-servers:telegram.qrRefreshes")}
            </p>

            <div className="flex justify-between">
              <Button type="button" variant="outline" asChild>
                <a href={loginState?.qr_link ?? "#"}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {t("mcp-servers:telegram.openInTelegram")}
                </a>
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => closeDialog(false)}
              >
                {t("common:cancel")}
              </Button>
            </div>
          </div>
        )}

        {step === "password" && (
          <div className="space-y-4">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              {t("mcp-servers:telegram.passwordNeeded")}
            </p>

            <div className="space-y-2">
              <Label htmlFor="telegram-password">
                {t("mcp-servers:telegram.password")}
              </Label>
              <Input
                id="telegram-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && password) {
                    event.preventDefault();
                    void handlePassword();
                  }
                }}
                autoComplete="one-time-code"
                autoFocus
              />
              {loginState?.password_hint ? (
                <p className="text-xs text-muted-foreground">
                  {t("mcp-servers:telegram.passwordHint", {
                    hint: loginState.password_hint,
                  })}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => closeDialog(false)}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="button"
                onClick={handlePassword}
                disabled={!password || submitPassword.isPending}
              >
                {submitPassword.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("mcp-servers:telegram.submitPassword")}
              </Button>
            </div>
          </div>
        )}

        {step === "confirm" && loginState && (
          <div className="space-y-4">
            <p className="text-sm">
              {t("mcp-servers:telegram.signedInAs", {
                account: describeAccount(loginState),
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("mcp-servers:telegram.createHelp", { name: serverName })}
            </p>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => closeDialog(false)}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleCreate}
                disabled={createServer.isPending}
              >
                {createServer.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("mcp-servers:telegram.createServer")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
