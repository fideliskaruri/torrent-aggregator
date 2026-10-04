import { useEffect, useMemo, useState } from "react";

export function useSelection<T>(
  items: readonly T[],
  key: (item: T) => string,
) {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  const presentIds = useMemo(() => new Set(items.map(key)), [items, key]);
  const selectedIds = useMemo(
    () => new Set([...ids].filter((id) => presentIds.has(id))),
    [ids, presentIds],
  );
  const selected = useMemo(
    () => items.filter((item) => selectedIds.has(key(item))),
    [items, key, selectedIds],
  );

  useEffect(() => {
    setIds((current) => {
      const next = new Set([...current].filter((id) => presentIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [presentIds]);

  const toggle = (id: string) => {
    setIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (presentIds.has(id)) next.add(id);
      return next;
    });
  };
  const toggleAll = () => setIds((current) =>
    items.length && items.every((item) => current.has(key(item)))
      ? new Set([...current].filter((id) => !presentIds.has(id)))
      : new Set([...current, ...presentIds]),
  );

  return {
    selected,
    selectedIds,
    toggle,
    toggleAll,
    clear: () => setIds(new Set()),
    allSelected: items.length > 0 && items.every((item) => selectedIds.has(key(item))),
    someSelected: selected.length > 0 && selected.length < items.length,
  };
}
