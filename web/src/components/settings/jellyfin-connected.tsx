import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/tf/confirm-dialog";
import { ToggleRow } from "@/components/settings/desktop-section";
import {
  SUGGEST_COUNTS,
  connectedLine,
  disconnect,
  loadUsers,
  personName,
  saveOptions,
  type JellyfinOptions,
  type JellyfinStatus,
  type JellyfinUser,
} from "@/lib/jellyfin";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { JellyfinFolders } from "./jellyfin-folders";
import { JellyfinSignIn } from "./jellyfin-signin";

const LANGUAGES: { code: string; name: string }[] = [
  { code: "eng", name: "English" }, { code: "spa", name: "Spanish" }, { code: "fre", name: "French" },
  { code: "ger", name: "German" }, { code: "ita", name: "Italian" }, { code: "por", name: "Portuguese" },
  { code: "dut", name: "Dutch" }, { code: "swe", name: "Swedish" }, { code: "pol", name: "Polish" },
  { code: "rus", name: "Russian" }, { code: "ara", name: "Arabic" }, { code: "hin", name: "Hindi" },
  { code: "jpn", name: "Japanese" }, { code: "kor", name: "Korean" }, { code: "chi", name: "Chinese" },
  { code: "swa", name: "Swahili" }, { code: "tur", name: "Turkish" },
];
const languageName = (code: string) => LANGUAGES.find((item) => item.code === code)?.name ?? code.toUpperCase();

type Users = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; users: JellyfinUser[] };

function Group({ title, hint, children, ...rest }: { title: string; hint?: string; children: ReactNode }
  & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <section className="space-y-2" {...rest}>
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {hint ? <p className="mt-0.5 text-xs text-subtle-foreground">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function JellyfinConnected({ status, onChange }: { status: JellyfinStatus; onChange: (next: JellyfinStatus) => void }) {
  const [saving, setSaving] = useState<keyof JellyfinOptions | null>(null);
  const [reauth, setReauth] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [publicUrl, setPublicUrl] = useState(status.publicUrl ?? "");
  const [users, setUsers] = useState<Users>({ status: "loading" });
  const ok = status.connection === "ok";
  const admin = ok && status.isAdmin;

  useEffect(() => {
    if (!admin) return;
    let live = true;
    loadUsers().then((list) => live && setUsers({ status: "ready", users: list }))
      .catch((error: unknown) => live && setUsers({ status: "error", error: error instanceof Error ? error.message : "Could not load Jellyfin users." }));
    return () => { live = false; };
  }, [admin]);

  async function save(field: keyof JellyfinOptions, options: JellyfinOptions, done?: string) {
    setSaving(field);
    try {
      onChange(await saveOptions(options));
      if (done) toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save this change. Try again.");
    } finally {
      setSaving(null);
    }
  }

  async function leave() {
    setLeaving(true);
    try {
      onChange(await disconnect());
      setConfirmOff(false);
      toast.success("Jellyfin disconnected.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect Jellyfin. Try again.");
    } finally {
      setLeaving(false);
    }
  }

  if (reauth) {
    return <JellyfinSignIn initialServer={status.serverUrl ?? ""} onCancel={() => setReauth(false)}
      onConnected={(next) => { setReauth(false); onChange(next); }} />;
  }

  const watchers = status.watchUserIds.length > 0 ? status.watchUserIds : status.userId ? [status.userId] : [];
  const publicDirty = publicUrl.trim() !== (status.publicUrl ?? "");

  return (
    <div className="space-y-6" data-jellyfin-connected>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground" data-jellyfin-status={status.connection}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ok ? "bg-success" : "bg-warning")} />
            {connectedLine(status)}
          </p>
          <p className="mt-0.5 break-all text-xs text-subtle-foreground">
            {status.serverName ? `${status.serverName} at ${status.serverUrl}` : status.serverUrl}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={ok ? "ghost" : "default"} onClick={() => setReauth(true)} data-jellyfin-reauth>
            {ok ? "Change account" : "Sign in again"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setConfirmOff(true)} data-jellyfin-disconnect>Disconnect</Button>
        </div>
      </div>

      {!ok ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          {status.message} Your choices below are kept.
        </p>
      ) : !status.isAdmin ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground" data-jellyfin-not-admin>
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          This account is not a Jellyfin admin. Sign in with an admin account to add folders to Jellyfin and choose whose
          watching counts.
        </p>
      ) : null}

      <Group title="Address for your devices" hint="Play in Jellyfin opens this address. Use the one your phone and TV reach."
        data-jellyfin-public>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => {
          event.preventDefault();
          if (publicDirty) void save("publicUrl", { publicUrl: publicUrl.trim() || null }, "Address saved.");
        }}>
          <Input aria-label="Address for your devices" type="url" inputMode="url" value={publicUrl} maxLength={2048}
            placeholder={status.serverUrl ?? ""} onChange={(event) => setPublicUrl(event.target.value)}
            className="min-w-0 flex-1" data-jellyfin-public-input />
          <Button type="submit" variant="secondary" disabled={!publicDirty || saving !== null}
            aria-busy={saving === "publicUrl"}>{saving === "publicUrl" ? "Saving…" : "Save"}</Button>
        </form>
      </Group>

      <Group title="Libraries" data-jellyfin-libraries>
        <ToggleRow id="jellyfin-sync" label="Add my storage folders to Jellyfin"
          description="New storage folders join your Movies and Shows libraries, and new downloads show up within a minute. Nothing is ever removed from Jellyfin unless you ask."
          checked={status.syncLibraries} disabled={!admin || saving !== null} busy={saving === "syncLibraries"}
          onChange={(checked) => void save("syncLibraries", { syncLibraries: checked })} data-jellyfin-sync />
        {admin ? (
          <div className="space-y-2 pt-2">
            <p className="text-xs text-subtle-foreground">
              When Jellyfin runs on another PC it reaches your storage through a shared folder. Enter each folder the way
              Jellyfin sees it, then check it.
            </p>
            <JellyfinFolders status={status} onSaved={onChange} />
          </div>
        ) : null}
      </Group>

      <Group title="Suggestions" hint="Episodes after the one you last watched show on Home. Nothing downloads by itself."
        data-jellyfin-suggest>
        <Select value={String(status.suggestNextEpisodes)} disabled={saving !== null}
          onValueChange={(value) => void save("suggestNextEpisodes", { suggestNextEpisodes: Number(value) })}>
          <SelectTrigger aria-label="Suggest next episodes" className="w-full sm:w-56" data-jellyfin-suggest-count>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUGGEST_COUNTS.map((count) => (
              <SelectItem key={count} value={String(count)}>
                {count === 0 ? "Don't suggest episodes" : `Suggest the next ${count === 1 ? "episode" : `${count} episodes`}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Group>

      {admin ? (
        <Group title="People" hint="Whose Jellyfin account drives each person's watchlist and suggestions, and whose watching counts before cleanup offers to free space."
          data-jellyfin-people>
          {users.status === "loading" ? <p className="text-xs text-subtle-foreground" aria-busy="true">Loading Jellyfin users…</p>
            : users.status === "error" ? (
              <p role="alert" className="text-sm text-destructive">{users.error}</p>
            ) : (
              <div className="space-y-4">
                {status.people.map((person) => {
                  const id = String(person.id);
                  const current = status.userMappings.find((mapping) => mapping.torrentFlowUserId === id)?.jellyfinUserId
                    ?? (person.owner ? status.userId ?? "" : "");
                  return (
                    <div key={id} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <Label htmlFor={`jf-person-${id}`} className="text-sm font-normal">{personName(person)} watches as</Label>
                      <Select value={current || "__none"} disabled={saving !== null} onValueChange={(value) => void save("userMappings", {
                        userMappings: [
                          ...status.userMappings.filter((mapping) => mapping.torrentFlowUserId !== id),
                          ...(value === "__none" ? [] : [{ torrentFlowUserId: id, jellyfinUserId: value }]),
                        ],
                      })}>
                        <SelectTrigger id={`jf-person-${id}`} className="w-full sm:w-56" data-jellyfin-person={id}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">Nobody in Jellyfin</SelectItem>
                          {users.users.map((user) => <SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  );
                })}
                <fieldset className="space-y-1" data-jellyfin-watchers>
                  <legend className="text-sm text-foreground">Counts as watched when all of these have watched it</legend>
                  {users.users.map((user) => {
                    const checked = watchers.includes(user.id);
                    const last = checked && watchers.length === 1;
                    return (
                      <Label key={user.id} htmlFor={`jf-watch-${user.id}`}
                        className={cn("flex min-h-11 items-center gap-3 font-normal", last ? "cursor-not-allowed" : "cursor-pointer")}>
                        <Checkbox id={`jf-watch-${user.id}`} checked={checked} disabled={last || saving !== null}
                          data-jellyfin-watcher={user.id}
                          onCheckedChange={(value) => void save("watchUserIds", {
                            watchUserIds: value === true ? [...watchers, user.id] : watchers.filter((item) => item !== user.id),
                          })} />
                        <span className="text-sm">{user.name}</span>
                      </Label>
                    );
                  })}
                </fieldset>
              </div>
            )}
        </Group>
      ) : null}

      <Group title="Subtitles" hint="Jellyfin fetches subtitles in these languages for new downloads that have none."
        data-jellyfin-subtitles>
        <div className="flex flex-wrap items-center gap-2">
          {status.subtitleLanguages.map((code) => (
            <span key={code} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 py-1 pl-2.5 pr-1 text-sm">
              {languageName(code)}
              <Button type="button" variant="ghost" size="icon-sm" aria-label={`Stop fetching ${languageName(code)} subtitles`}
                disabled={saving !== null} data-jellyfin-subtitle-remove={code}
                onClick={() => void save("subtitleLanguages", { subtitleLanguages: status.subtitleLanguages.filter((item) => item !== code) })}>
                <X aria-hidden className="size-3.5" />
              </Button>
            </span>
          ))}
          <Select value="" disabled={saving !== null}
            onValueChange={(code) => void save("subtitleLanguages", { subtitleLanguages: [...status.subtitleLanguages, code] })}>
            <SelectTrigger aria-label="Add a subtitle language" className="w-full sm:w-48" data-jellyfin-subtitle-add>
              <SelectValue placeholder={status.subtitleLanguages.length ? "Add a language" : "Off. Add a language"} />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.filter((item) => !status.subtitleLanguages.includes(item.code)).map((item) => (
                <SelectItem key={item.code} value={item.code}>{item.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {status.subtitleLanguages.length > 0 && status.subtitleProviderMissing ? (
          <p className="text-sm text-warning" role="status" data-jellyfin-subtitle-provider-missing>
            Install the OpenSubtitles plugin in Jellyfin to get subtitles.
          </p>
        ) : null}
      </Group>

      <ConfirmDialog open={confirmOff} onOpenChange={(next) => !leaving && setConfirmOff(next)} title="Disconnect Jellyfin?"
        description="TorrentFlow stops showing watch progress, Play in Jellyfin and suggestions. Your Jellyfin libraries stay as they are."
        confirmLabel="Disconnect" busy={leaving} onConfirm={() => void leave()} />
    </div>
  );
}
