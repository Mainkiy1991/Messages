# Messages User Guide

Messages is an open-source non-commercial messenger without email or phone. Sign in with a seed phrase of 12 or 24 words. Messages are encrypted on your device, and the server cannot read their contents. The interface is available in Russian, English, and Ukrainian.

## Getting started

### Create an account
1. Tap **Create account** on the welcome screen.
2. Choose the number of seed words: **12 words** or **24 words**. More words mean stronger protection.
3. Write the generated phrase down on paper and keep it in a safe place. Never show it to anyone.
4. Tap **I have saved the phrase**, then verify three words from the phrase in order.
5. Tap **Finish account setup** — your account is ready.

### Sign in on another device
1. Tap **Sign in with seed phrase**.
2. Enter the full phrase of 12 or 24 words and tap **Sign in**.
3. Your account and contacts become available after syncing with the server.

## Seed phrase: the golden rule

- Your seed phrase is the only key to your account. If you lose it, the account cannot be recovered. There is no support team.
- Never show the phrase to anyone and never enter it on suspicious websites.
- Do not store the phrase in phone notes, photos, cloud storage, or send it in messengers. The best option is paper, kept in a secure place.

## How to start a chat

1. Open **Profile** — your **User ID** (64 characters) is displayed there.
2. Tap **Copy** next to your ID and send this string to your contact any way you like.
3. To start a chat, tap **Create chat**, enter the **Contact ID** (64 lowercase hex characters) and tap **New chat**.
4. If you have not set a contact name, the last 10 characters of their ID are shown instead of a name in the chat list. To set a name, open the chat, choose **Contact name (optional)**, enter a name and tap **Save name**.

## Messages and statuses

When sending a message, the status changes in sequence:

- **sending** — the message is being transmitted to the server.
- **sent** — the server has accepted the message.
- **delivered** — the message has been delivered to the recipient's device.
- **read** — the recipient has opened the chat and the message is marked as read.
- **failed** — could not send. Check your connection and tap **Retry**.

The connection status is shown next to the contact's name or ID:

- **online** — the contact is online.
- **offline** — the connection is lost.

## PIN (optional)

PIN adds extra protection for local keys on this device. It is not sent to the server and is not stored separately from the encrypted session.

- **What it does:** after enabling PIN, keys are removed from device storage and exist in memory only after unlocking. Someone who gets access to your browser cannot decrypt the keys or read history without the PIN.
- **How to enable:** in Profile, tap **PIN**, then **Enable PIN**, create and confirm your PIN. We recommend at least **8 characters**, preferably with letters. A short PIN is easier to guess.
- **Forgot PIN:** tap **Forgot PIN?**, then **End session**. Keys on this device will be erased. To use the account again, sign in with your seed phrase. Messages remain on the server and are restored after you sign in again.
- **Pauses after incorrect entries:** the first four wrong attempts have no pause. After the fifth — a 5-minute pause, after the sixth — 15 minutes, after the seventh and every subsequent — 60 minutes.

## Sign out

Tap **Sign out** in Profile. This erases keys from this device. You can sign in again only with your seed phrase. Make sure you have saved it before signing out.

## Language

The interface language is detected automatically from your browser settings. To change it manually, open **Language** and select Russian, English, or Ukrainian. Your choice is saved in the browser.

## Honest limitations

- The server can see who messages whom and when, as well as message length, but not message contents.
- No account recovery. Losing the seed phrase means losing the account.
- There has been no independent security audit. The project is in the testing stage.
- No forward secrecy: if the seed phrase leaks, past conversations can be read too.
- The server is hosted on a free hosting plan. After downtime, the first sign-in may take up to a minute.
- Only text one-to-one messages and web-only for now. No groups, files, calls, or mobile apps.