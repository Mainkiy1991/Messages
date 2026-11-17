export type LongPressPointer = {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
};

export function createLongPressHandlers(
  onLongPress: () => void,
  delayMs = 500,
  moveThreshold = 10,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pointer: { id: number; x: number; y: number } | null = null;
  let suppressClick = false;

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pointer = null;
  }

  return {
    onPointerDown(event: LongPressPointer) {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      cancel();
      suppressClick = false;
      pointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      timer = setTimeout(() => {
        timer = null;
        if (!pointer) return;
        suppressClick = true;
        onLongPress();
      }, delayMs);
    },
    onPointerMove(event: LongPressPointer) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >
        moveThreshold
      )
        cancel();
    },
    onPointerUp(event: LongPressPointer) {
      if (pointer?.id === event.pointerId) cancel();
    },
    onPointerCancel(event: LongPressPointer) {
      if (pointer?.id === event.pointerId) cancel();
    },
    consumeSuppressedClick() {
      if (!suppressClick) return false;
      suppressClick = false;
      return true;
    },
    dispose: cancel,
  };
}

export type LongPressHandlers = ReturnType<typeof createLongPressHandlers>;
