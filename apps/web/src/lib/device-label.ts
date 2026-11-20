export type DeviceLabel = { browser: string; os: string };

export function detectDeviceLabel(userAgent: string): DeviceLabel {
  let browser = "unknown";
  if (/Edg\//u.test(userAgent)) browser = "Edge";
  else if (
    /Chrome|Chromium|CriOS/u.test(userAgent) &&
    !/OPR|Opera|OPiOS/u.test(userAgent)
  )
    browser = "Chrome";
  else if (/Firefox|FxiOS/u.test(userAgent)) browser = "Firefox";
  else if (/Safari/u.test(userAgent)) browser = "Safari";

  let os = "unknown";
  if (/iPhone|iPad|iPod/u.test(userAgent)) os = "iOS";
  else if (/Android/u.test(userAgent)) os = "Android";
  else if (/Windows/u.test(userAgent)) os = "Windows";
  else if (/Mac OS X|Macintosh/u.test(userAgent)) os = "macOS";
  else if (/Linux/u.test(userAgent)) os = "Linux";

  return { browser, os };
}
