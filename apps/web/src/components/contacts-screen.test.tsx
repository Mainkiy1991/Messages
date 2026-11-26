import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { strings, type Language } from "../i18n.js";
import {
  ContactsScreen,
  contactErrorText,
  contactsBackAction,
  peerCardFromContacts,
  type ContactsScreenProps,
} from "./contacts-screen.js";
import type { ContactError } from "../lib/chat-controller.js";

const id = "0123456789abcdef".repeat(4);
const errors: ContactError[] = [
  "invalid_id",
  "own_id",
  "contacts_not_loaded",
  "name_required",
  "name_too_long",
  "name_invalid",
  "note_too_long",
  "note_invalid",
  "not_a_contact",
  "already_contact",
  "limit_reached",
  "book_too_large",
  "user_not_found",
  "bad_peer_key",
  "server_unavailable",
  "save_failed",
];
function render(overrides: Partial<ContactsScreenProps> = {}) {
  const props: ContactsScreenProps = {
    controller: {
      addContact: async () => ({ ok: true }),
      renameContact: async () => ({ ok: true }),
      saveContactNote: async () => ({ ok: true }),
      removeContact: async () => ({ ok: true }),
      openChat: async () => {},
      getSnapshot: () => ({ activePeer: "", error: "" }) as never,
    },
    contacts: {},
    notes: {},
    ready: true,
    loadFailed: false,
    language: "ru",
    strings: strings.ru,
    chatErrorText: () => "chat error",
    onClose: () => {},
    onChatOpened: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(<ContactsScreen {...props} />);
}

describe("contacts screen", () => {
  it("shows loading state", () =>
    expect(render({ ready: false })).toContain("Загружаем контакты…"));
  it("shows loading failure", () =>
    expect(render({ loadFailed: true })).toContain('role="alert"'));
  it("shows empty state", () =>
    expect(render()).toContain("Контактов пока нет."));
  it("shows contact rows in pick mode without add action", () => {
    const html = render({ pickMode: true, contacts: { [id]: "Алиса" } });
    expect(html).toContain("Выбрать контакт");
    expect(html).not.toContain('data-testid="contact-add-open"');
    expect(html).toContain('data-testid="contact-row"');
  });
  it("shows pick mode empty hint", () => {
    expect(render({ pickMode: true })).toContain(strings.ru.contactsPickEmpty);
  });
  it("keeps the regular contacts list controls", () => {
    const html = render({ contacts: { [id]: "Алиса" } });
    expect(html).toContain("Контакты");
    expect(html).toContain('data-testid="contact-add-open"');
  });
  it("sorts names case-insensitively", () => {
    const html = render({ contacts: { d: "Виктор", b: "боб", a: "Алиса" } });
    expect(html.indexOf("Алиса")).toBeLessThan(html.indexOf("боб"));
    expect(html.indexOf("боб")).toBeLessThan(html.indexOf("Виктор"));
  });
  it("shows ID tail and note, and omits absent note", () => {
    const html = render({
      contacts: { [id]: "Алиса", peer2: "Боб" },
      notes: { [id]: "Моя заметка" },
    });
    expect(html).toContain(id.slice(-10));
    expect(html).toContain("Моя заметка");
    expect(html).not.toContain("Описания нет");
  });
  it("renders a card with full ID and note", () => {
    const html = render({
      contacts: { [id]: "Алиса" },
      notes: { [id]: "Описание" },
      initialView: { view: "card", peerId: id },
    });
    expect(html).toContain(`data-testid="contact-card-id"`);
    expect(html).toContain(`aria-label="Копировать ID"`);
    expect(html).toContain(`<code>${id}</code>`);
    expect(html).not.toContain(`>Копировать<`);
    expect(html).toContain("Описание");
  });
  it("renders the back button as an icon with an accessible label", () => {
    const html = render({
      initialView: { view: "card", peerId: id },
      contacts: { [id]: "Алиса" },
    });
    expect(html).toContain('data-testid="contacts-back"');
    expect(html).toContain('aria-label="Назад"');
    expect(html).toContain("<svg");
    expect(html).not.toContain(">Назад</button>");
  });
  it("renders icon-only name and note edit buttons", () => {
    const html = render({
      initialView: { view: "card", peerId: id },
      contacts: { [id]: "Алиса" },
    });
    expect(html).toContain('aria-label="Изменить имя"');
    expect(html).toContain('aria-label="Изменить описание"');
    expect(html).not.toContain(">Изменить имя<");
    expect(html).not.toContain(">Изменить описание<");
  });
  it("explains contact removal in the confirmation", () => {
    expect(strings.ru.contactsRemovePrompt).toContain("имя в чате пропадёт");
  });
  it("shows empty note label", () =>
    expect(
      render({
        contacts: { [id]: "Алиса" },
        initialView: { view: "card", peerId: id },
      }),
    ).toContain("Описания нет"));
  it("falls back to list when card contact is missing", () =>
    expect(render({ initialView: { view: "card", peerId: id } })).not.toContain(
      "contact-card-id",
    ));
  it("renders add fields", () => {
    const html = render({ initialView: { view: "add" } });
    expect(html).toContain("contact-add-id");
    expect(html).toContain("contact-add-name");
    expect(html).toContain("contact-add-note");
    expect(html).toContain("Описание (необязательно)");
    expect(html).toContain('placeholder="Кто это и зачем добавлен"');
  });
  it("disables add action until contacts are ready", () =>
    expect(render({ ready: false })).toContain(
      'data-testid="contact-add-open" disabled',
    ));
  it("provides distinct non-empty translations for every error", () => {
    for (const lang of ["ru", "en", "uk"] as Language[]) {
      const values = errors.map((e) =>
        contactErrorText(strings[lang] as never, e),
      );
      expect(values.every(Boolean)).toBe(true);
      expect(new Set(values).size).toBe(errors.length);
    }
  });
  it("shows the peer view and its add action", () => {
    const html = render({ initialView: { view: "peer", peerId: id } });
    expect(html).toContain("Нет в ваших контактах");
    expect(html).toContain('data-testid="contact-peer-add"');
    expect(html).toContain(`<code>${id}</code>`);
  });
  it("renders peer add with a read-only peer ID", () => {
    const html = render({ initialView: { view: "peerAdd", peerId: id } });
    expect(html).toContain(`readOnly="" value="${id}"`);
    expect(html).toContain('data-testid="contact-add-name"');
    expect(html).toContain('data-testid="contact-add-note"');
    expect(html).toContain('data-testid="contact-add-submit"');
  });
  it("moves from peer views to a card when updated contacts include the peer", () => {
    expect(
      peerCardFromContacts({ view: "peerAdd", peerId: id }, { [id]: "Bob" }),
    ).toBe(id);
    expect(peerCardFromContacts({ view: "peer", peerId: id }, {})).toBeNull();
  });
  it("routes Back from peer, peer add, and chat cards correctly", () => {
    const state = {
      busy: false,
      editing: false,
      confirmRemove: false,
      fromChat: true,
    };
    expect(
      contactsBackAction({ ...state, view: { view: "peer", peerId: id } }),
    ).toBe("close");
    expect(
      contactsBackAction({ ...state, view: { view: "peerAdd", peerId: id } }),
    ).toBe("peer");
    expect(
      contactsBackAction({ ...state, view: { view: "card", peerId: id } }),
    ).toBe("close");
    expect(
      contactsBackAction({
        ...state,
        fromChat: false,
        view: { view: "card", peerId: id },
      }),
    ).toBe("list");
  });
  it("does not route Back while busy", () => {
    expect(
      contactsBackAction({
        busy: true,
        editing: false,
        confirmRemove: false,
        fromChat: true,
        view: { view: "peerAdd", peerId: id },
      }),
    ).toBe("stay");
  });
  it("hides Write for chat cards and keeps it for profile contacts", () => {
    const chat = render({
      initialView: { view: "card", peerId: id },
      contacts: { [id]: "Bob" },
      chatPeerId: id,
    });
    const profile = render({
      initialView: { view: "card", peerId: id },
      contacts: { [id]: "Bob" },
    });
    expect(chat).not.toContain('data-testid="contact-write"');
    expect(profile).toContain('data-testid="contact-write"');
  });
});
