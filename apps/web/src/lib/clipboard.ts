// Use only for public, non-secret text such as peer IDs, never seed phrases or other secrets.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      typeof window !== "undefined" &&
      window.isSecureContext &&
      navigator.clipboard
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy clipboard API.
  }

  let textarea: HTMLTextAreaElement | null = null;
  let copied = false;
  let cleanupSucceeded = true;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.padding = "0";
    textarea.style.border = "0";
    textarea.style.opacity = "0";
    textarea.style.overflow = "hidden";
    document.body.appendChild(textarea);
    textarea.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    try {
      textarea?.remove();
    } catch {
      cleanupSucceeded = false;
    }
  }
  return copied && cleanupSucceeded;
}
