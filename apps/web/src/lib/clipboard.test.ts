import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

function installClipboardEnvironment(options: {
  secureContext?: boolean;
  writeText?: (text: string) => Promise<void>;
  execCommand?: () => boolean;
}) {
  let attached = false;
  let removed = false;
  const textarea = {
    value: "",
    readOnly: false,
    style: {},
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn(() => {
      attached = false;
      removed = true;
    }),
  } as unknown as HTMLTextAreaElement;
  const documentMock = {
    createElement: vi.fn(() => textarea),
    body: {
      appendChild: vi.fn(() => {
        attached = true;
      }),
    },
    execCommand: vi.fn(options.execCommand ?? (() => false)),
  } as unknown as Document;

  vi.stubGlobal("window", {
    isSecureContext: options.secureContext ?? true,
  } as unknown as Window);
  vi.stubGlobal(
    "navigator",
    options.writeText
      ? ({
          clipboard: { writeText: options.writeText },
        } as unknown as Navigator)
      : ({} as Navigator),
  );
  vi.stubGlobal("document", documentMock);

  return {
    documentMock,
    textarea,
    wasRemoved: () => removed && !attached,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyText", () => {
  it("uses the secure clipboard API when it succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { documentMock } = installClipboardEnvironment({ writeText });

    await expect(copyText("public-id")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("public-id");
    expect(documentMock.createElement).not.toHaveBeenCalled();
  });

  it("falls back when clipboard writing rejects and removes the textarea", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { documentMock, textarea, wasRemoved } = installClipboardEnvironment({
      writeText,
      execCommand: () => true,
    });

    await expect(copyText("public-id")).resolves.toBe(true);

    expect(documentMock.execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(wasRemoved()).toBe(true);
  });

  it("returns false when both clipboard methods fail and removes the textarea", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("unavailable"));
    const { documentMock, textarea, wasRemoved } = installClipboardEnvironment({
      writeText,
      execCommand: () => false,
    });

    await expect(copyText("public-id")).resolves.toBe(false);

    expect(documentMock.execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(wasRemoved()).toBe(true);
  });

  it("uses the fallback when the clipboard API is unavailable or context is insecure", async () => {
    const { documentMock, textarea, wasRemoved } = installClipboardEnvironment({
      secureContext: false,
      execCommand: () => true,
    });

    await expect(copyText("public-id")).resolves.toBe(true);

    expect(documentMock.createElement).toHaveBeenCalledWith("textarea");
    expect(textarea.remove).toHaveBeenCalledOnce();
    expect(wasRemoved()).toBe(true);
  });

  it("uses the fallback instead of the clipboard API in an insecure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { documentMock } = installClipboardEnvironment({
      secureContext: false,
      writeText,
      execCommand: () => true,
    });

    await expect(copyText("public-id")).resolves.toBe(true);

    expect(writeText).not.toHaveBeenCalled();
    expect(documentMock.execCommand).toHaveBeenCalledWith("copy");
  });
});
