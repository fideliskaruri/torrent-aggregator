import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { connectWithKey, signIn, type JellyfinStatus } from "@/lib/jellyfin";

/** Sign in with a Jellyfin account. An API key is the fallback for setups without a password login. */
export function JellyfinSignIn({
  initialServer,
  onConnected,
  onCancel,
}: {
  initialServer: string;
  onConnected: (status: JellyfinStatus) => void;
  onCancel?: () => void;
}) {
  const [server, setServer] = useState(initialServer);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = server.trim() !== "" && (useKey
    ? apiKey.trim() !== "" && userId.trim() !== ""
    : username.trim() !== "" && password !== "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const status = useKey
        ? await connectWithKey(server.trim(), userId.trim(), apiKey.trim())
        : await signIn(server.trim(), username.trim(), password);
      setPassword("");
      setApiKey("");
      onConnected(status);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not connect to Jellyfin. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)} data-jellyfin-signin aria-busy={busy}>
      <FormField label="Server address" htmlFor="jellyfin-server"
        hint="The address you open Jellyfin with, for example http://192.168.1.20:8096.">
        <Input id="jellyfin-server" data-jellyfin-server type="url" inputMode="url" autoComplete="url"
          placeholder="http://192.168.1.20:8096" value={server} maxLength={2048}
          onChange={(event) => setServer(event.target.value)} disabled={busy} />
      </FormField>
      {!useKey ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Username" htmlFor="jellyfin-username">
            <Input id="jellyfin-username" data-jellyfin-username autoComplete="username" value={username}
              maxLength={200} onChange={(event) => setUsername(event.target.value)} disabled={busy} />
          </FormField>
          <FormField label="Password" htmlFor="jellyfin-password">
            <Input id="jellyfin-password" data-jellyfin-password type="password" autoComplete="current-password"
              value={password} maxLength={4096} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          </FormField>
        </div>
      ) : null}
      <Collapsible open={useKey} onOpenChange={setUseKey}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="link" className="h-auto min-h-11 px-0 text-xs" data-jellyfin-use-key>
            {useKey ? "Sign in with a password instead" : "Use an API key instead"}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-4 pt-2 sm:grid-cols-2">
          <FormField label="API key" htmlFor="jellyfin-key" hint="In Jellyfin: Dashboard, API keys.">
            <Input id="jellyfin-key" data-jellyfin-key type="password" autoComplete="off" value={apiKey}
              maxLength={4096} onChange={(event) => setApiKey(event.target.value)} disabled={busy} />
          </FormField>
          <FormField label="User ID" htmlFor="jellyfin-user"
            hint="Open your profile in Jellyfin and copy the id from the address bar.">
            <Input id="jellyfin-user" data-jellyfin-user value={userId} maxLength={200}
              onChange={(event) => setUserId(event.target.value)} disabled={busy} />
          </FormField>
        </CollapsibleContent>
      </Collapsible>
      {error ? <p role="alert" className="text-sm text-destructive" data-jellyfin-error>{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!ready || busy} aria-busy={busy} data-jellyfin-connect>
          {busy ? "Connecting…" : useKey ? "Connect" : "Sign in"}
        </Button>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
      </div>
    </form>
  );
}
