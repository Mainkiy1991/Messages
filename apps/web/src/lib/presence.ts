import type { Language } from "../i18n.js";

export function formatPresence(
  online: boolean,
  lastSeenAt: string | null,
  language: Language,
  now = Date.now(),
): string {
  if (online) return language === "ru" ? "в сети" : "online";
  if (!lastSeenAt) return "";
  const time = Date.parse(lastSeenAt);
  if (!Number.isFinite(time)) return "";
  const age = Math.max(0, now - time);
  const locale = language === "ru" ? "ru-RU" : "en-US";
  const prefix = language === "ru" ? "был(а) в сети " : "last seen ";
  if (age < 60_000)
    return language === "ru" ? "был(а) в сети сейчас" : "last seen just now";
  if (age < 60 * 60_000) {
    const minutes = Math.floor(age / 60_000);
    return language === "ru"
      ? `${prefix}${minutes} мин. назад`
      : `${prefix}${minutes} min. ago`;
  }
  const date = new Date(time);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, new Date(now))) {
    const clock = date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return language === "ru"
      ? `${prefix}сегодня в ${clock}`
      : `${prefix}today at ${clock}`;
  }
  if (sameDay(date, yesterday)) {
    const clock = date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return language === "ru"
      ? `${prefix}вчера в ${clock}`
      : `${prefix}yesterday at ${clock}`;
  }
  if (date.getFullYear() === new Date(now).getFullYear()) {
    const calendar = date.toLocaleDateString(locale, {
      day: "numeric",
      month: "long",
    });
    return `${prefix}${calendar}`;
  }
  return `${prefix}${date.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" })}`;
}
