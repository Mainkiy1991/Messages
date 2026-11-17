import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLongPressHandlers,
  type LongPressPointer,
} from "./long-press.js";

const touch: LongPressPointer = {
  pointerId: 1,
  pointerType: "touch",
  clientX: 20,
  clientY: 30,
};

describe("long press", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after exactly 500 ms", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const handlers = createLongPressHandlers(onLongPress);

    handlers.onPointerDown(touch);
    vi.advanceTimersByTime(499);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    handlers.dispose();
  });

  it("does not fire after an early release", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const handlers = createLongPressHandlers(onLongPress);

    handlers.onPointerDown(touch);
    handlers.onPointerUp(touch);
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    handlers.dispose();
  });

  it("cancels after movement greater than 10 px", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const handlers = createLongPressHandlers(onLongPress);

    handlers.onPointerDown(touch);
    handlers.onPointerMove({ ...touch, clientX: 31 });
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    handlers.dispose();
  });

  it("ignores mouse pointers", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const handlers = createLongPressHandlers(onLongPress);

    handlers.onPointerDown({ ...touch, pointerType: "mouse" });
    vi.advanceTimersByTime(500);
    expect(onLongPress).not.toHaveBeenCalled();
    handlers.dispose();
  });

  it("suppresses only the click following a long press", () => {
    vi.useFakeTimers();
    const handlers = createLongPressHandlers(vi.fn());

    handlers.onPointerDown(touch);
    vi.advanceTimersByTime(500);
    handlers.onPointerUp(touch);
    expect(handlers.consumeSuppressedClick()).toBe(true);
    expect(handlers.consumeSuppressedClick()).toBe(false);
    handlers.dispose();
  });
});
