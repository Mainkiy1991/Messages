import type { ChangeEvent, ComponentProps, KeyboardEvent } from "react";

export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]/gu, "");
}

type SingleLineFieldProps = Omit<ComponentProps<"textarea">, "rows" | "wrap">;

export function SingleLineField({
  className,
  enterKeyHint = "go",
  onChange,
  onKeyDown,
  ...props
}: SingleLineFieldProps) {
  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = stripLineBreaks(event.currentTarget.value);
    event.currentTarget.value = value;
    onChange?.(event);
    if ((event.nativeEvent as InputEvent).inputType === "insertLineBreak") {
      const form = event.currentTarget.form;
      window.setTimeout(() => form?.requestSubmit(), 0);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
    onKeyDown?.(event);
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
