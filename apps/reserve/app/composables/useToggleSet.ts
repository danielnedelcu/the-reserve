// app/composables/useToggleSet.ts
export function useToggleSet<T = string>() {
  const set = shallowRef<Set<T>>(new Set());
  function toggle(id: T) {
    const next = new Set(set.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set.value = next;
  }
  const has = (id: T) => set.value.has(id);
  function clear() {
    set.value = new Set();
  }
  return { set, toggle, has, clear };
}
