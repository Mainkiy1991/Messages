import { describe, expect, it } from "vitest";
import { nextFabState, type FabState } from "./fab-visibility.js";

describe("nextFabState", () => {
  it("shows the button at the top of the list", () => {
    expect(nextFabState({ hidden: true, anchor: 40 }, 0)).toEqual({
      hidden: false,
      anchor: 0,
    });
  });

  it("hides after scrolling down beyond the threshold", () => {
    expect(nextFabState({ hidden: false, anchor: 0 }, 9)).toEqual({
      hidden: true,
      anchor: 9,
    });
  });

  it("keeps the state after a small movement", () => {
    const state: FabState = { hidden: false, anchor: 0 };
    expect(nextFabState(state, 7)).toBe(state);
  });

  it("shows after scrolling up beyond the threshold", () => {
    expect(nextFabState({ hidden: true, anchor: 20 }, 11)).toEqual({
      hidden: false,
      anchor: 11,
    });
  });

  it("resets the anchor and shows at scrollTop zero", () => {
    expect(nextFabState({ hidden: true, anchor: 600 }, 0)).toEqual({
      hidden: false,
      anchor: 0,
    });
  });
});
