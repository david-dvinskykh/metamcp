"use client";

import { FileRelayProvider } from "@repo/zod-types";
import { Bot, Check, HardDrive, Loader2, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/hooks/useTranslations";
import { trpc } from "@/lib/trpc";

/**
 * File relay connections, one set per signed-in user.
 *
 * Everything shown here is scoped to the account viewing the page: the backend
 * reads and writes credentials keyed on the session's user id, and never
 * returns a token or refresh token to the browser — only a label and a date.
 */

const POLL_INTERVAL_MS = 2000;

function formatWhen(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

export function FileRelayConnections() {
  const { t } = useTranslations();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.frontend.fileRelay.getStatus.useQuery();

  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [driveState, setDriveState] = useState<string | null>(null);

  const telegram = data?.connections.find(
    (connection) => connection.provider === "TELEGRAM_BOT",
  );
  const drive = data?.connections.find(
    (connection) => connection.provider === "GOOGLE_DRIVE",
  );

  const refresh = useCallback(() => {
    void utils.frontend.fileRelay.getStatus.invalidate();
  }, [utils]);

  const connectBot = trpc.frontend.fileRelay.connectTelegramBot.useMutation({
    onSuccess: (result) => {
      if (!result.success) {
        toast.error(result.message);
        return;
      }
      toast.success(
        t("settings:fileRelay.telegramConnected", {
          label: result.connection.label ?? "",
        }),
      );
      setBotDialogOpen(false);
      setBotToken("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const disconnect = trpc.frontend.fileRelay.disconnect.useMutation({
    onSuccess: () => {
      toast.success(t("settings:fileRelay.disconnected"));
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const startDriveAuth =
    trpc.frontend.fileRelay.startGoogleDriveAuth.useMutation({
      onSuccess: (result) => {
        if (!result.success) {
          toast.error(result.message);
          return;
        }
        setDriveState(result.state);
        // A popup keeps the settings page (and its polling) alive; if the
        // browser blocks it, the same tab navigates instead.
        const opened = window.open(result.auth_url, "_blank", "noopener");
        if (!opened) {
          window.location.href = result.auth_url;
        }
      },
      onError: (error) => toast.error(error.message),
    });

  // Poll only while a consent is actually outstanding.
  const { data: driveAuthStatus } =
    trpc.frontend.fileRelay.getGoogleDriveAuthStatus.useQuery(
      { state: driveState ?? "" },
      {
        enabled: Boolean(driveState),
        refetchInterval: driveState ? POLL_INTERVAL_MS : false,
      },
    );

  // `refresh` and `t` change identity on every render, so the effect keys on
  // the status alone and reads the rest through a ref.
  const handlersRef = useRef({ refresh, t });
  useEffect(() => {
    handlersRef.current = { refresh, t };
  });

  useEffect(() => {
    if (!driveAuthStatus || !driveState) return;

    if (driveAuthStatus.status === "connected") {
      setDriveState(null);
      handlersRef.current.refresh();
      toast.success(
        handlersRef.current.t("settings:fileRelay.driveConnected", {
          label: driveAuthStatus.connection?.label ?? "",
        }),
      );
      return;
    }

    if (driveAuthStatus.status === "failed") {
      setDriveState(null);
      toast.error(
        driveAuthStatus.message ??
          handlersRef.current.t("settings:fileRelay.driveFailed"),
      );
    }
  }, [driveAuthStatus, driveState]);

  const isDisconnecting = (provider: FileRelayProvider) =>
    disconnect.isPending && disconnect.variables?.provider === provider;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings:fileRelay.title")}</CardTitle>
        <CardDescription>{t("settings:fileRelay.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("settings:loading")}
          </div>
        ) : (
          <>
            {/* Telegram bot */}
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <Bot className="mt-0.5 h-5 w-5 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("settings:fileRelay.telegramTitle")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("settings:fileRelay.telegramDescription")}
                  </p>
                  {telegram?.connected ? (
                    <p className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
                      <Check className="h-3.5 w-3.5" />
                      {telegram.label}
                      {formatWhen(telegram.connected_at) ? (
                        <span className="text-muted-foreground">
                          · {formatWhen(telegram.connected_at)}
                        </span>
                      ) : null}
                    </p>
                  ) : telegram?.deployment_fallback ? (
                    <p className="text-xs text-muted-foreground">
                      {t("settings:fileRelay.usingDeploymentBot")}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant={telegram?.connected ? "outline" : "default"}
                  size="sm"
                  onClick={() => setBotDialogOpen(true)}
                >
                  {telegram?.connected
                    ? t("settings:fileRelay.reconnect")
                    : t("settings:fileRelay.connectTelegram")}
                </Button>
                {telegram?.connected && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isDisconnecting("TELEGRAM_BOT")}
                    onClick={() =>
                      disconnect.mutate({ provider: "TELEGRAM_BOT" })
                    }
                  >
                    {isDisconnecting("TELEGRAM_BOT") ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Unplug className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Google Drive */}
            <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
              <div className="flex items-start gap-3">
                <HardDrive className="mt-0.5 h-5 w-5 text-muted-foreground" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">
                    {t("settings:fileRelay.driveTitle")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("settings:fileRelay.driveDescription")}
                  </p>
                  {drive?.connected ? (
                    <p className="flex items-center gap-1.5 text-sm text-green-600 dark:text-green-500">
                      <Check className="h-3.5 w-3.5" />
                      {drive.label}
                      {formatWhen(drive.connected_at) ? (
                        <span className="text-muted-foreground">
                          · {formatWhen(drive.connected_at)}
                        </span>
                      ) : null}
                    </p>
                  ) : drive?.problem ? (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                      {drive.problem}
                    </p>
                  ) : drive?.deployment_fallback ? (
                    <p className="text-xs text-muted-foreground">
                      {t("settings:fileRelay.usingDeploymentDrive")}
                    </p>
                  ) : null}
                  {driveState ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t("settings:fileRelay.waitingForConsent")}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant={drive?.connected ? "outline" : "default"}
                  size="sm"
                  disabled={
                    startDriveAuth.isPending ||
                    Boolean(driveState) ||
                    Boolean(drive?.problem && !drive?.connected)
                  }
                  onClick={() => startDriveAuth.mutate()}
                >
                  {startDriveAuth.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  {drive?.connected
                    ? t("settings:fileRelay.reconnect")
                    : t("settings:fileRelay.connectDrive")}
                </Button>
                {drive?.connected && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isDisconnecting("GOOGLE_DRIVE")}
                    onClick={() =>
                      disconnect.mutate({ provider: "GOOGLE_DRIVE" })
                    }
                  >
                    {isDisconnecting("GOOGLE_DRIVE") ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Unplug className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("settings:fileRelay.isolationNote")}
            </p>
          </>
        )}
      </CardContent>

      <Dialog open={botDialogOpen} onOpenChange={setBotDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("settings:fileRelay.telegramDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("settings:fileRelay.telegramDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="file-relay-bot-token">
              {t("settings:fileRelay.botTokenLabel")}
            </Label>
            <Input
              id="file-relay-bot-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AAE...."
              value={botToken}
              onChange={(event) => setBotToken(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBotDialogOpen(false)}>
              {t("settings:fileRelay.cancel")}
            </Button>
            <Button
              disabled={botToken.trim().length === 0 || connectBot.isPending}
              onClick={() => connectBot.mutate({ bot_token: botToken.trim() })}
            >
              {connectBot.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t("settings:fileRelay.connect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
