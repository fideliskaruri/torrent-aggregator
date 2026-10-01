import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  readDownloadLimits,
  setMaxActiveDownloads,
  type DownloadLimits,
} from "@/lib/download-limits";
import { startVisiblePoller } from "./polling";

/** Pressing + three times in a row sends one save. */
const SAVE_DELAY_MS = 400;
/** Download hours open and close on the hour, so a slow re-read is plenty. */
const REFRESH_MS = 60_000;

/**
 * Downloads at once for the Downloads status line. Every press shows at once,
 * one save goes out after the presses stop, and a failed save puts the
 * previous value back with a message. `onSaved` re-reads the downloads so rows
 * move between queued and downloading without waiting for the next poll.
 */
export function useMaxActiveDownloads({
  enabled,
  onSaved,
}: {
  enabled: boolean;
  onSaved: () => void;
}) {
  const [limits, setLimits] = useState<DownloadLimits | null>(null);
  /** The first read has answered, either way. */
  const [settled, setSettled] = useState(false);
  const [draft, setDraft] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The value waiting for the save delay, if any. */
  const pendingRef = useRef<number | null>(null);
  /** Bumped on every press, so an older save settling can't undo a newer press. */
  const pressRef = useRef(0);
  /** Bumped when a save starts, so a read that began before it is dropped. */
  const writesRef = useRef(0);
  const savingRef = useRef(0);
  const savedRef = useRef<number | null>(null);
  const onSavedRef = useRef(onSaved);

  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  useEffect(() => {
    savedRef.current = limits?.saved ?? null;
  }, [limits]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const writes = writesRef.current;
    const next = await readDownloadLimits(signal);
    if (signal?.aborted) return;
    setSettled(true);
    if (!next) return;
    if (writes !== writesRef.current || savingRef.current > 0 || pendingRef.current != null) return;
    setLimits(next);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void refresh(abort.signal);
    const stop = startVisiblePoller({ poll: () => refresh(), intervalMs: () => REFRESH_MS });
    return () => {
      abort.abort();
      stop();
    };
  }, [enabled, refresh]);

  const save = useCallback(async (value: number, press: number) => {
    pendingRef.current = null;
    if (value === savedRef.current) {
      if (press === pressRef.current) setDraft(null);
      return;
    }
    writesRef.current += 1;
    savingRef.current += 1;
    const result = await setMaxActiveDownloads(value);
    savingRef.current -= 1;
    if (result.ok) {
      setLimits(
        (prev) =>
          result.limits ??
          (prev && {
            ...prev,
            saved: value,
            effective: prev.source === "schedule" ? prev.effective : value,
          }),
      );
      if (press === pressRef.current) setDraft(null);
      onSavedRef.current();
      return;
    }
    if (press !== pressRef.current) return;
    setDraft(null);
    toast.error(result.message);
  }, []);

  const change = useCallback(
    (value: number) => {
      const press = ++pressRef.current;
      setDraft(value);
      pendingRef.current = value;
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void save(value, press), SAVE_DELAY_MS);
    },
    [save],
  );

  // Leaving the page right after a press still saves it.
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      const pending = pendingRef.current;
      if (pending != null && pending !== savedRef.current) void setMaxActiveDownloads(pending);
    },
    [],
  );

  return {
    /** Null until the first read lands, and for a server without the setting. */
    limits,
    /** False until the first read answers, so the page can hold the control's place. */
    settled,
    /** The value to show: the latest press, else the saved value. */
    value: draft ?? limits?.saved ?? null,
    change,
  };
}