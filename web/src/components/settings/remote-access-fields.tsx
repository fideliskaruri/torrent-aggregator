import { Globe } from "lucide-react";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { ToggleRow } from "./desktop-section";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { RemoteAccessForm, RemoteAccessSettings } from "./remote-access-types";

const inputClass = "scroll-mb-32";

export function RemoteAccessFields({
  settings,
  form,
  readOnly,
  serviceUrl,
  onChange,
}: {
  settings: RemoteAccessSettings;
  form: RemoteAccessForm;
  readOnly: boolean;
  serviceUrl: string;
  onChange: (patch: Partial<RemoteAccessForm>) => void;
}) {
  return (
    <>
      <ToggleRow
        id="remote-access-enabled"
        label="Turn on remote access"
        description="Opens a second listener on this computer for cloudflared only."
        checked={form.enabled}
        disabled={readOnly}
        busy={false}
        onChange={(checked) => onChange({ enabled: checked })}
        data-remote-access-enabled
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Team domain" htmlFor="remote-access-team">
          <Input id="remote-access-team" value={form.teamDomain} disabled={readOnly}
            onChange={(event) => onChange({ teamDomain: event.target.value })}
            placeholder="myteam.cloudflareaccess.com" autoComplete="off" spellCheck={false}
            className={inputClass} data-remote-access-team />
        </FormField>
        <FormField label="Tunnel port" htmlFor="remote-access-port">
          <div className="flex flex-wrap items-center gap-2">
            <Input id="remote-access-port" type="number" min={1024} max={65535} step={1} inputMode="numeric"
              value={Number.isFinite(form.tunnelPort) ? form.tunnelPort : ""} disabled={readOnly}
              onChange={(event) => onChange({ tunnelPort: event.target.valueAsNumber })}
              className={cn(inputClass, "max-w-[10rem]")} aria-describedby="remote-access-port-help" data-remote-access-port />
            <span className="text-xs text-subtle-foreground">on</span>
            <Input id="remote-access-bind" value={settings.tunnelBindAddress} readOnly
              aria-label="Bind address (set in the settings file)"
              className={cn(inputClass, "w-auto max-w-[12rem] font-mono text-muted-foreground")} data-remote-access-bind />
          </div>
          <p id="remote-access-port-help" className="text-xs text-subtle-foreground">Not the port you open TorrentFlow on here.</p>
        </FormField>
      </div>
      <FormField label="Application Audience (AUD) tag" htmlFor="remote-access-audience">
        <Input id="remote-access-audience" value={form.audience} disabled={readOnly}
          onChange={(event) => onChange({ audience: event.target.value })}
          placeholder="Copied from the Access application's overview" autoComplete="off" spellCheck={false}
          className={cn(inputClass, "font-mono placeholder:font-sans placeholder:text-muted-foreground")} data-remote-access-audience />
      </FormField>
      <FormField label="Owner emails" htmlFor="remote-access-owners">
        <Textarea id="remote-access-owners" rows={3} value={form.ownerEmails} disabled={readOnly}
          onChange={(event) => onChange({ ownerEmails: event.target.value })}
          placeholder="you@example.com" autoComplete="off" spellCheck={false}
          aria-describedby="remote-access-owners-help" className="min-w-0 scroll-mb-32" data-remote-access-owners />
        <p id="remote-access-owners-help" className="text-xs text-subtle-foreground">
          One per line. Everyone else Cloudflare lets in is a requester, or refused if requests are off.
        </p>
      </FormField>
      <ToggleRow
        id="remote-access-requesters"
        label="Let friends request titles"
        description="Other signed-in emails can search titles, ask for them and follow their own requests. Nothing else."
        checked={form.allowRequesters}
        disabled={readOnly}
        busy={false}
        onChange={(checked) => onChange({ allowRequesters: checked })}
        data-remote-access-requesters
      />
      <div className="space-y-2 rounded-lg border border-border p-3" data-remote-access-steps>
        <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Globe className="size-4 text-subtle-foreground" aria-hidden="true" />Set it up in Cloudflare Zero Trust
        </h3>
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>Create a tunnel and install <code className="font-mono">cloudflared</code> on this computer with the command Cloudflare shows.</li>
          <li>Add a public hostname with the service <code className="break-all font-mono text-foreground">{serviceUrl}</code>.</li>
          <li>Create a self-hosted Access application for that hostname and allow only your email.</li>
          <li>Paste the team domain and AUD tag, add your email, turn on remote access, save, and restart TorrentFlow.</li>
        </ol>
      </div>
    </>
  );
}
