import { describe, expect, it } from "vitest";
import { stripLineBreaks } from "./single-line-field.js";

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
