import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  deriveKeys,
  generateMnemonic,
  normalizeMnemonic,
  userIdFromPublicKey,
  validateMnemonic,
  type DerivedKeys,
} from "@messages/crypto";
import {
  chooseCheckPositions,
  getInitialLanguage,
  strings,
  type Language,
} from "./i18n.js";
import { clearSession, restoreSession, saveSession } from "./session.js";
import "./style.css";

type Screen = "welcome" | "create" | "verify" | "login" | "home";

function App() {
  const [language, setLanguage] = useState<Language>(() =>
    getInitialLanguage(localStorage, navigator.language),
  );
  const t = strings[language];
  const [screen, setScreen] = useState<Screen>("welcome");
  const [keys, setKeys] = useState<DerivedKeys | null>(null);
  const [count, setCount] = useState<12 | 24>(12);
  const [phrase, setPhrase] = useState("");
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [hasError, setHasError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void restoreSession().then((saved) => {
      if (saved) {
        setKeys(saved);
        setScreen("home");
      }
    });
  }, []);
  function changeLanguage(next: Language) {
    setLanguage(next);
    localStorage.setItem("messages-language", next);
  }

  async function enter(mnemonic: string) {
    const derived = deriveKeys(normalizeMnemonic(mnemonic));
    await saveSession(derived);
    setKeys(derived);
    setPhrase("");
    setScreen("home");
    setHasError(false);
  }

  function beginCreate() {
    const words = generateMnemonic(count);
    setPhrase(words);
    setPositions(chooseCheckPositions(count));
    setAnswers(["", "", ""]);
    setHasError(false);
    setScreen("verify");
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasError(false);
    const clean = normalizeMnemonic(phrase);
    if (!validateMnemonic(clean)) {
      setHasError(true);
      return;
    }
    try {
      await enter(clean);
    } catch {
      setHasError(true);
    }
  }

  async function finishCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const words = phrase.split(" ");
    if (
      !answers.every(
        (answer, i) => normalizeMnemonic(answer) === words[positions[i]],
      )
    ) {
      setHasError(true);
      return;
    }
    try {
      await enter(phrase);
    } catch {
      setHasError(true);
    }
  }

  async function logout() {
    if (!window.confirm(t.confirmLogout)) return;
    await clearSession();
    setKeys(null);
    setPhrase("");
    setScreen("welcome");
  }

  const userId = keys ? userIdFromPublicKey(keys.identity.publicKey) : "";
  return (
    <main className="shell">
      <header>
        <a
          className="brand"
          onClick={() => screen === "welcome" && setScreen("welcome")}
        >
          {t.title}
        </a>
        <div className="language">
          <span>{t.language}</span>
          <button
            onClick={() => changeLanguage("ru")}
            aria-pressed={language === "ru"}
          >
            RU
          </button>
          <button
            onClick={() => changeLanguage("en")}
            aria-pressed={language === "en"}
          >
            EN
          </button>
        </div>
      </header>
      <section className="card">
        {screen === "welcome" && (
          <>
            <h1>{t.welcome}</h1>
            <button className="primary" onClick={() => setScreen("create")}>
              {t.create}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setPhrase("");
                setHasError(false);
                setScreen("login");
              }}
            >
              {t.login}
            </button>
          </>
        )}
        {screen === "create" && (
          <>
            <h1>{t.createTitle}</h1>
            <label>
              {t.words}
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value) as 12 | 24)}
              >
                <option value={12}>{t.twelve}</option>
                <option value={24}>{t.twentyFour}</option>
              </select>
            </label>
            <button className="primary" onClick={beginCreate}>
              {t.next}
            </button>
          </>
        )}
        {screen === "verify" && (
          <form onSubmit={finishCreate}>
            <h1>{t.verify}</h1>
            <p className="warning">{t.warning}</p>
            <ol className="seed-list">
              {phrase.split(" ").map((word, i) => (
                <li key={i}>
                  <span>{word}</span>
                </li>
              ))}
            </ol>
            <label className="checkbox">
              <input type="checkbox" required />
              {t.saved}
            </label>
            {positions.map((position, i) => (
              <label key={position}>
                {t.enterWord(position + 1)}
                <input
                  value={answers[i]}
                  onChange={(e) =>
                    setAnswers(
                      answers.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                />
              </label>
            ))}
            {hasError && <p className="error">{t.invalid}</p>}
            <button className="primary">{t.finish}</button>
          </form>
        )}
        {screen === "login" && (
          <form onSubmit={handleLogin}>
            <h1>{t.loginTitle}</h1>
            <label>
              {t.phrase}
              <textarea
                rows={4}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
              />
            </label>
            {hasError && <p className="error">{t.invalid}</p>}
            <button className="primary">{t.signIn}</button>
          </form>
        )}
        {screen === "home" && (
          <>
            <h1>{t.title}</h1>
            <p className="muted">{t.chats}</p>
            <div className="id-box">
              <label>{t.userId}</label>
              <code>{userId}</code>
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(userId).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? t.copied : t.copy}
              </button>
            </div>
            <button className="danger" onClick={() => void logout()}>
              {t.logout}
            </button>
          </>
        )}
        {(screen === "login" || screen === "create" || screen === "verify") && (
          <button
            className="text-button"
            onClick={() => {
              setHasError(false);
              setScreen(screen === "verify" ? "create" : "welcome");
            }}
          >
            {t.back}
          </button>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
