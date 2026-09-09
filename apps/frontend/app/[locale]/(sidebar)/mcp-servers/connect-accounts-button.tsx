"use client";

import { ConnectField, ConnectGroup, ConnectTarget } from "@repo/zod-types";
import { CheckCircle2, Loader2, LogIn, Plug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

/**
 * Generic MCP-Connect panel. It asks the backend to `describe` a server's
 * connect actions (read live from the server's tool `_meta`) and renders a
 * form per connectable target from the returned field schema, then runs the
 * declared connect/disconnect tool via `execute`. No per-server code — any
 * server that declares `ai.metamcp.connect/v1` actions gets this UI.
 */
export function ConnectAccountsButton({ serverUuid }: { serverUuid: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<ConnectGroup[] | null>(null);
  const describe = trpc.frontend.connect.describe.useMutation();

  const load = async () => {
    try {
      const res = await describe.mutateAsync({ serverUuid });
      if (res.success) {
        setGroups(res.groups);
      } else {
        setGroups([]);
        if (res.message) toast.error(res.message);
      }
    } catch (error) {
      setGroups([]);
      toast.error(
        error instanceof Error ? error.message : "Failed to load connect actions",
      );
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setGroups(null);
      void load();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <LogIn className="h-4 w-4 mr-2" />
          Connect accounts
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Connect accounts</DialogTitle>
          <DialogDescription>
            Sign in to the accounts this server needs. Credentials are sent
            straight to the server and stored there — MetaMCP never keeps them.
          </DialogDescription>
        </DialogHeader>

        {describe.isPending && !groups && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {groups && groups.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground">
            This server exposes no connect actions.
          </p>
        )}

        <div className="space-y-6">
          {groups?.map((group) => (
            <GroupSection
              key={group.group}
              serverUuid={serverUuid}
              group={group}
              onChanged={load}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GroupSection({
  serverUuid,
  group,
  onChanged,
}: {
  serverUuid: string;
  group: ConnectGroup;
  onChanged: () => void | Promise<void>;
}) {
  // A group either lists concrete targets (stores/accounts) or, failing that,
  // carries a single fallback form built from the connect tool's inputSchema.
  const targets: ConnectTarget[] =
    group.targets.length > 0
      ? group.targets
      : [{ id: "", fields: group.fields ?? [] }];

  return (
    <div className="space-y-3">
      {group.label && (
        <div className="text-sm font-medium">{group.label}</div>
      )}
      {targets.map((target, i) => (
        <TargetForm
          key={target.id || `fallback-${i}`}
          serverUuid={serverUuid}
          group={group}
          target={target}
          isFallback={group.targets.length === 0}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

type Step = {
  fields: ConnectField[];
  resumeTool?: string;
  continuation?: string;
  prompt?: string;
};

function TargetForm({
  serverUuid,
  group,
  target,
  isFallback,
  onChanged,
}: {
  serverUuid: string;
  group: ConnectGroup;
  target: ConnectTarget;
  isFallback: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const execute = trpc.frontend.connect.execute.useMutation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState<Step | null>(null);

  const fields = step?.fields ?? target.fields;
  const connectTool = step?.resumeTool ?? group.connectTool;

  const setField = (name: string, value: string) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const missingRequired = fields.some(
    (f) => f.required && !((values[f.name] ?? f.default ?? "").trim()),
  );

  const buildArgs = (): Record<string, unknown> => {
    const collected: Record<string, string> = {};
    for (const f of fields) {
      const v = values[f.name] ?? f.default ?? "";
      if (v !== "") collected[f.name] = v;
    }
    const args: Record<string, unknown> = {};
    if (step?.continuation !== undefined) {
      args.continuation = step.continuation;
    } else if (group.targetArg && !isFallback) {
      args[group.targetArg] = target.id;
    }
    if (group.fieldsArg) args[group.fieldsArg] = collected;
    else Object.assign(args, collected);
    return args;
  };

  const connect = async () => {
    if (!connectTool) return;
    try {
      const res = await execute.mutateAsync({
        serverUuid,
        toolName: connectTool,
        arguments: buildArgs(),
      });
      if (!res.ok) {
        toast.error(res.message || "Could not connect");
        return;
      }
      if (res.redirect?.url) {
        window.open(res.redirect.url, "_blank", "noopener");
      }
      if (res.next) {
        setStep({
          fields: res.next.fields,
          resumeTool: res.next.resumeTool,
          continuation: res.next.continuation,
          prompt: res.next.prompt,
        });
        setValues({});
        toast.info(res.next.prompt || "One more step is required");
        return;
      }
      toast.success(res.message || "Connected");
      setStep(null);
      setValues({});
      await onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not connect");
    }
  };

  const disconnect = async () => {
    if (!group.disconnectTool) return;
    try {
      const args: Record<string, unknown> = {};
      if (group.targetArg) args[group.targetArg] = target.id;
      const res = await execute.mutateAsync({
        serverUuid,
        toolName: group.disconnectTool,
        arguments: args,
      });
      if (res.ok) {
        toast.success(res.message || "Disconnected");
        await onChanged();
      } else {
        toast.error(res.message || "Could not disconnect");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not disconnect",
      );
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">
            {target.label || target.id || "Account"}
          </span>
        </div>
        {target.connected ? (
          <Badge variant="secondary" className="gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Connected
          </Badge>
        ) : (
          <Badge variant="outline">Not connected</Badge>
        )}
      </div>

      {target.notes?.map((note, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}

      {step?.prompt && <p className="text-xs">{step.prompt}</p>}

      {fields.map((field) => (
        <div key={field.name} className="space-y-1">
          <Label htmlFor={`${target.id}-${field.name}`} className="text-xs">
            {field.name}
            {field.required && <span className="text-destructive"> *</span>}
          </Label>
          <Input
            id={`${target.id}-${field.name}`}
            type={field.secret ? "password" : "text"}
            autoComplete={field.secret ? "off" : undefined}
            placeholder={field.placeholder || field.description}
            value={values[field.name] ?? ""}
            onChange={(e) => setField(field.name, e.target.value)}
          />
          {field.description && (
            <p className="text-[11px] text-muted-foreground">
              {field.description}
            </p>
          )}
        </div>
      ))}

      <div className="flex items-center gap-2">
        {connectTool && (
          <Button
            size="sm"
            onClick={connect}
            disabled={execute.isPending || missingRequired}
          >
            {execute.isPending && (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            )}
            {step
              ? "Continue"
              : target.connected
                ? "Reconnect"
                : "Connect"}
          </Button>
        )}
        {target.connected && group.disconnectTool && !step && (
          <Button
            size="sm"
            variant="outline"
            onClick={disconnect}
            disabled={execute.isPending}
          >
            Disconnect
          </Button>
        )}
      </div>
    </div>
  );
}
