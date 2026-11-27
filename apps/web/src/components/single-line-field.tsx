import { useLayoutEffect, useRef } from "react";
import type { ChangeEvent, ComponentProps, KeyboardEvent } from "react";

export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

export function lineBreakWasTyped(raw: string, inputType: string): boolean {
  return /[\r\n]/u.test(raw) && !inputType.startsWith("insertFrom");
}

type SingleLineFieldProps = Omit<
  ComponentProps<"textarea">,
  "rows" | "wrap"
> & {
  onEnter?: () => void;
};

export function SingleLineField({
  className,
  enterKeyHint = "go",
  onEnter,
  onChange,
  onKeyDown,
  ...props
}: SingleLineFieldProps) {
  const onEnterRef = useRef(onEnter);
  useLayoutEffect(() => {
    onEnterRef.current = onEnter;
  });

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const raw = event.currentTarget.value;
    const value = stripLineBreaks(raw);
    const inputType = (event.nativeEvent as InputEvent).inputType ?? "";
    const form = event.currentTarget.form;
    if (raw !== value) event.currentTarget.value = value;
    onChange?.(event);
    if (lineBreakWasTyped(raw, inputType)) {
      window.setTimeout(
        () =>
          onEnterRef.current ? onEnterRef.current() : form?.requestSubmit(),
        0,
      );
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (onEnterRef.current) onEnterRef.current();
      else form?.requestSubmit();
    }
  }

  return (
    <textarea
      {...props}
      className={
        className ? `single-line-field ${className}` : "single-line-field"
      }
      rows={1}
      wrap="off"
      enterKeyHint={enterKeyHint}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
    />
  );
}
