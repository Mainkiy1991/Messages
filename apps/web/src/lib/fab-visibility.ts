export type FabState = { hidden: boolean; anchor: number };

export function nextFabState(
  state: FabState,
  scrollTop: number,
  threshold = 8,
): FabState {
  if (scrollTop <= 0) return { hidden: false, anchor: 0 };

  const delta = scrollTop - state.anchor;
  if (delta > threshold) return { hidden: true, anchor: scrollTop };
  if (delta < -threshold) return { hidden: false, anchor: scrollTop };
  return state;
}
