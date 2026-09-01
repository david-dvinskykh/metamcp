"use client";

import {
  INSTAGRAM_MCP_DEFAULT_COMMAND,
  INSTAGRAM_MCP_DEFAULT_SERVER_NAME,
  InstagramLoginState,
} from "@repo/zod-types";
import {
  ChevronDown,
  ExternalLink,
  Instagram,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useState } from "react";
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

type Step = "credentials" | "code" | "confirm" | "cookies";

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function InstagramConnectorButton() {
  const { t } = useTranslations();
  const utils = trpc.useUtils();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("credentials");
  const [error, setError] = useState<string | null>(null);

  // Connector settings, shared by both paths
  const [serverName, setServerName] = useState(
    INSTAGRAM_MCP_DEFAULT_SERVER_NAME,
  );
  const [command, setCommand] = useState(INSTAGRAM_MCP_DEFAULT_COMMAND);
  const [isPublic, setIsPublic] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Login path
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loginState, setLoginState] = useState<InstagramLoginState | null>(
    null,
  );

  // Cookie-paste fallback
  const [sessionId, setSessionId] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [dsUserId, setDsUserId] = useState("");

  const startLogin = trpc.frontend.instagram.startLogin.useMutation();
  const submitCode = trpc.frontend.instagram.submitCode.useMutation();
  const cancelLogin = trpc.frontend.instagram.cancelLogin.useMutation();
  const createServer = trpc.frontend.instagram.createServer.useMutation();
  const createFromCookies =
    trpc.frontend.instagram.createServerFromCookies.useMutation();

  const validName = () =>
    SERVER_NAME_PATTERN.test(serverName) && !/_{2,}/.test(serverName);

  const applyState = useCallback((state: InstagramLoginState) => {
    setLoginState(state);
    setStep(state.phase === "AUTHENTICATED" ? "confirm" : "code");
  }, []);

  const messageOf = (value: unknown, fallback: string) =>
    value instanceof Error ? value.message : fallback;

  const closeDialog = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) return;
      const loginId = loginState?.login_id;
      if (loginId) {
        cancelLogin.mutate({ login_id: loginId });
      }
      setStep("credentials");
      setError(null);
      setPassword("");
      setCode("");
      setSessionId("");
      setCsrfToken("");
      setDsUserId("");
      setLoginState(null);
    },
    [cancelLogin, loginState],
  );

  /** The MCP server was created: refresh the list and close up. */
  const finish = useCallback(() => {
    setLoginState(null);
    utils.frontend.mcpServers.list.invalidate();
    toast.success(t("mcp-servers:instagram.created"));
    closeDialog(false);
  }, [closeDialog, t, utils]);

  const handleStart = async () => {
    setError(null);
    if (!validName()) {
      setError(t("mcp-servers:instagram.invalidName"));
      return;
    }
    if (!username.trim() || !password) {
      setError(t("mcp-servers:instagram.credentialsRequired"));
      return;
    }
    try {
      const response = await startLogin.mutateAsync({
        username: username.trim(),
        password,
      });
      if (response.success && response.data) {
        setPassword("");
        applyState(response.data);
      } else {
        setError(response.message ?? t("mcp-servers:instagram.loginFailed"));
      }
    } catch (startError) {
      setError(messageOf(startError, t("mcp-servers:instagram.loginFailed")));
    }
  };

  const handleCode = async () => {
    const loginId = loginState?.login_id;
    if (!loginId) return;
    setError(null);
    try {
      const response = await submitCode.mutateAsync({
        login_id: loginId,
        code,
      });
      if (response.success && response.data) {
        setCode("");
        applyState(response.data);
      } else {
        setError(response.message ?? t("mcp-servers:instagram.loginFailed"));
      }
    } catch (codeError) {
      setError(messageOf(codeError, t("mcp-servers:instagram.loginFailed")));
    }
  };

  const handleCreate = async () => {
    const loginId = loginState?.login_id;
    if (!loginId) return;
    setError(null);
    try {
      const response = await createServer.mutateAsync({
        login_id: loginId,
        name: serverName,
        command: command.trim() || INSTAGRAM_MCP_DEFAULT_COMMAND,
        user_id: isPublic ? null : undefined,
      });
      if (response.success) {
        finish();
      } else {
        setError(response.message ?? t("mcp-servers:createError"));
      }
    } catch (createError) {
      setError(messageOf(createError, t("mcp-servers:createError")));
    }
  };

  const handleCreateFromCookies = async () => {
    setError(null);
    if (!validName()) {
      setError(t("mcp-servers:instagram.invalidName"));
      return;
    }
    if (!/^\d+$/.test(dsUserId.trim())) {
      setError(t("mcp-servers:instagram.invalidDsUserId"));
      return;
    }
    try {
      const response = await createFromCookies.mutateAsync({
        name: serverName,
        command: command.trim() || INSTAGRAM_MCP_DEFAULT_COMMAND,
        user_id: isPublic ? null : undefined,
        session_id: sessionId.trim(),
        csrf_token: csrfToken.trim(),
        ds_user_id: dsUserId.trim(),
      });
      if (response.success) {
        finish();
      } else {
        setError(response.message ?? t("mcp-servers:createError"));
      }
    } catch (createError) {
      setError(messageOf(createError, t("mcp-servers:createError")));
    }
  };

  /**
   * Say where the code actually comes from. Instagram acts on one channel and
   * sends nothing at all when the account uses an authenticator app, so
   * "we texted you" is the wrong thing to show for most accounts.
   */
  const codeSourceText = () => {
    switch (loginState?.two_factor_method) {
      case "TOTP":
        return t("mcp-servers:instagram.codeFromApp");
      case "EMAIL":
        return t("mcp-servers:instagram.codeFromEmail");
      default:
        return loginState?.phone_hint
          ? t("mcp-servers:instagram.codeFromSmsWithHint", {
              hint: loginState.phone_hint,
            })
          : t("mcp-servers:instagram.codeFromSms");
    }
  };

  /**
   * True when the code would have to be delivered to the user — by text or by
   * email — rather than read out of an authenticator app.
   *
   * Instagram only sends one after the delivery method is chosen through its
   * own two-step flow, which this connector has no way to drive, so for these
   * accounts no message is coming and the cookie path is the way through. A
   * code from an app needs no sending, so that case is left alone.
   */
  const codeMustBeSent =
    loginState?.two_factor_method === "SMS" ||
    loginState?.two_factor_method === "EMAIL";

  /** Channels the account also has, in case the expected one stays silent. */
  const otherPlaces = (() => {
    const methods = loginState?.two_factor_methods;
    const preferred = loginState?.two_factor_method;
    if (!methods) return [];
    const places: string[] = [];
    if (methods.totp && preferred !== "TOTP") {
      places.push(t("mcp-servers:instagram.placeApp"));
    }
    if (methods.sms && preferred !== "SMS") {
      places.push(t("mcp-servers:instagram.placeSms"));
    }
    if (methods.email && preferred !== "EMAIL") {
      places.push(t("mcp-servers:instagram.placeEmail"));
    }
    return places;
  })();

  const settingsFields = (
    <>
      <div className="space-y-2">
        <Label htmlFor="instagram-server-name">{t("mcp-servers:name")}</Label>
        <Input
          id="instagram-server-name"
          value={serverName}
          onChange={(event) => setServerName(event.target.value)}
          placeholder={INSTAGRAM_MCP_DEFAULT_SERVER_NAME}
        />
      </div>

      <div className="space-y-2">
        <Label>{t("mcp-servers:ownership")}</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between">
              {isPublic ? t("mcp-servers:public") : t("mcp-servers:private")}
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
          {t("mcp-servers:instagram.advanced")}
        </button>
        {showAdvanced && (
          <div className="space-y-2">
            <Label htmlFor="instagram-command">
              {t("mcp-servers:command")}
            </Label>
            <Input
              id="instagram-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={INSTAGRAM_MCP_DEFAULT_COMMAND}
            />
            <p className="text-xs text-muted-foreground">
              {t("mcp-servers:instagram.commandHelp")}
            </p>
          </div>
        )}
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={closeDialog}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Instagram className="mr-2 h-4 w-4" />
          {t("mcp-servers:instagram.connect")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("mcp-servers:instagram.title")}</DialogTitle>
          <DialogDescription>
            {t("mcp-servers:instagram.description")}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-destructive break-words">{error}</p>
        )}

        {step === "credentials" && (
          <div className="space-y-4">
            {settingsFields}

            <div className="space-y-2">
              <Label htmlFor="instagram-username">
                {t("mcp-servers:instagram.username")}
              </Label>
              <Input
                id="instagram-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="your_handle"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="instagram-password">
                {t("mcp-servers:instagram.password")}
              </Label>
              <Input
                id="instagram-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && username && password) {
                    event.preventDefault();
                    void handleStart();
                  }
                }}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t("mcp-servers:instagram.passwordHelp")}
              </p>
            </div>

            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => {
                setError(null);
                setStep("cookies");
              }}
            >
              {t("mcp-servers:instagram.useCookiesInstead")}
            </button>

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
                {t("mcp-servers:instagram.signIn")}
              </Button>
            </div>
          </div>
        )}

        {step === "code" && (
          <div className="space-y-4">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              {codeSourceText()}
            </p>

            {codeMustBeSent && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                {t("mcp-servers:instagram.codeNotSent")}
              </p>
            )}

            {loginState?.sms_unavailable_reason && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("mcp-servers:instagram.smsUnavailable", {
                  reason: loginState.sms_unavailable_reason,
                })}
              </p>
            )}

            {otherPlaces.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("mcp-servers:instagram.otherPlaces", {
                  places: otherPlaces.join(", "),
                })}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="instagram-code">
                {t("mcp-servers:instagram.code")}
              </Label>
              <Input
                id="instagram-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && code) {
                    event.preventDefault();
                    void handleCode();
                  }
                }}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
              />
            </div>

            <p className="text-xs text-muted-foreground">
              {t("mcp-servers:instagram.noCodeHelp")}
            </p>

            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => {
                setError(null);
                const loginId = loginState?.login_id;
                if (loginId) cancelLogin.mutate({ login_id: loginId });
                setLoginState(null);
                setCode("");
                setStep("cookies");
              }}
            >
              {t("mcp-servers:instagram.useCookiesInstead")}
            </button>

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
                onClick={handleCode}
                disabled={!code || submitCode.isPending}
              >
                {submitCode.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("mcp-servers:instagram.submitCode")}
              </Button>
            </div>
          </div>
        )}

        {step === "confirm" && loginState && (
          <div className="space-y-4">
            <p className="text-sm">
              {t("mcp-servers:instagram.signedInAs", {
                account: `@${loginState.username}`,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("mcp-servers:instagram.createHelp", { name: serverName })}
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
                {t("mcp-servers:instagram.createServer")}
              </Button>
            </div>
          </div>
        )}

        {step === "cookies" && (
          <div className="space-y-4">
            {settingsFields}

            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>
                {t("mcp-servers:instagram.cookieStepOpen")}{" "}
                <a
                  className="underline inline-flex items-center gap-1"
                  href="https://www.instagram.com"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  instagram.com
                  <ExternalLink className="h-3 w-3" />
                </a>
              </li>
              <li>{t("mcp-servers:instagram.cookieStepDevtools")}</li>
              <li>{t("mcp-servers:instagram.cookieStepCopy")}</li>
            </ol>

            <div className="space-y-2">
              <Label htmlFor="instagram-sessionid">sessionid</Label>
              <Input
                id="instagram-sessionid"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="instagram-csrftoken">csrftoken</Label>
              <Input
                id="instagram-csrftoken"
                value={csrfToken}
                onChange={(event) => setCsrfToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="instagram-dsuserid">ds_user_id</Label>
              <Input
                id="instagram-dsuserid"
                value={dsUserId}
                onChange={(event) => setDsUserId(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => {
                setError(null);
                setStep("credentials");
              }}
            >
              {t("mcp-servers:instagram.backToSignIn")}
            </button>

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
                onClick={handleCreateFromCookies}
                disabled={
                  !sessionId ||
                  !csrfToken ||
                  !dsUserId ||
                  createFromCookies.isPending
                }
              >
                {createFromCookies.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("mcp-servers:instagram.createServer")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
