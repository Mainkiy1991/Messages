import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { strings } from "../i18n.js";
import { NewChatScreen, type NewChatScreenProps } from "./new-chat-screen.js";

function render(overrides: Partial<NewChatScreenProps> = {}) {
  const props: NewChatScreenProps = {
    view: "menu",
    strings: strings.ru,
    contacts: {},
    contactsReady: true,
    contactsLoadFailed: false,
    language: "ru",
    onBack: () => {},
    onChooseView: () => {},
    onPickContact: async () => "",
    onSubmitId: async () => "",
    ...overrides,
  };
  return renderToStaticMarkup(<NewChatScreen {...props} />);
}

describe("new chat screen", () => {
  it("renders the menu title and both choices", () => {
    const html = render();
    expect(html).toContain("Новый чат");
    expect(html).toContain('data-testid="new-chat-from-contacts"');
    expect(html).toContain('data-testid="new-chat-by-id"');
  });
  it("sorts contact rows in the same locale order as contacts", () => {
    const html = render({
      view: "pick",
      contacts: { p3: "Виктор", p2: "боб", p1: "Алиса" },
    });
    expect(html.indexOf("Алиса")).toBeLessThan(html.indexOf("боб"));
    expect(html.indexOf("боб")).toBeLessThan(html.indexOf("Виктор"));
  });
  it("shows the empty and loading states in contact selection", () => {
    expect(render({ view: "pick" })).toContain(strings.ru.contactsPickEmpty);
    expect(render({ view: "pick", contactsReady: false })).toContain(
      strings.ru.contactsLoading,
    );
  });
  it("renders ID and optional name fields with an uncancelled hint", () => {
    const html = render({ view: "id" });
    expect(html).toContain('data-testid="peer-id-input"');
    expect(html).toContain('aria-label="Имя (необязательно)"');
    expect(html).toContain('data-testid="new-chat-name-hint"');
    expect(html).not.toContain(">Отмена<");
  });
});
