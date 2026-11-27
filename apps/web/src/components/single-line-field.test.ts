import { describe, expect, it } from "vitest";
import { lineBreakWasTyped, stripLineBreaks } from "./single-line-field.js";

describe("stripLineBreaks", () => {
  it("removes newline characters", () => {
    expect(stripLineBreaks("first\nsecond")).toBe("firstsecond");
  });

  it("removes both characters in CRLF line endings", () => {
    expect(stripLineBreaks("first\r\nsecond")).toBe("firstsecond");
  });

  it("preserves values without line breaks", () => {
    expect(stripLineBreaks("single line")).toBe("single line");
  });
});

describe("lineBreakWasTyped", () => {
  it.each([
    ["word\n", "insertCompositionText", true],
    ["word\n", "insertLineBreak", true],
    ["word\n", "insertFromPaste", false],
    ["word", "insertText", false],
    ["word\r\n", "insertCompositionText", true],
  ])("checks %j with %s", (raw, inputType, expected) => {
    expect(lineBreakWasTyped(raw, inputType)).toBe(expected);
  });
});
