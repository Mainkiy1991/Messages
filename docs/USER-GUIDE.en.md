# Messages User Guide

Messages is an open-source non-commercial messenger without email or phone. Sign in with a seed phrase of 12 or 24 words. Messages are encrypted on your device, and the server cannot read their contents. The interface is available in Russian, English, and Ukrainian.

## Getting started

### Create an account

1. Tap **Create account** on the welcome screen.
2. Choose the number of seed words — **12 words** or **24 words** — and tap **Continue**. 24 words give more headroom, while 12 words are enough and easier to write down.
3. On the **Verify phrase** screen, write all the words down in order on paper and keep the sheet in a safe place. Never show the phrase to anyone.
4. On the same screen, tick the **I have saved the phrase** checkbox, enter the three requested words in the **Enter word #…** fields and tap **Finish account setup** — your account is ready.

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

## Saved messages

Saved messages is a chat with yourself: notes, links, anything you do not want to lose.

- Open **New chat** and enter your own ID from Profile — **Saved messages** opens. Its row is always the first one in the chat list.
- Notes are encrypted exactly like normal messages and synced: after signing in with the seed phrase they are available on all your devices.
- Saved messages have no delivery or read statuses, no unread counter and no "online" status: you write only to yourself. The name cannot be changed, and clearing the chat deletes the notes only for you.
- Honestly about metadata: the server can see that you wrote notes to yourself and when, but never their contents.

## Messages and statuses

The status of your message is shown under it and changes in order:

- **sending** — the message is being transmitted to the server.
- **sent** — the server has accepted the message.
- **delivered** — the message has reached the recipient's device.
- **read** — the recipient opened the chat in a visible tab and the message is marked as read.
- **failed** — the message could not be sent. Check your connection and tap **Retry**.

The contact's status is shown next to their name or ID:

- **online** — the contact is in the messenger right now.
- **last seen …** — the contact is offline, followed by the time of their last visit, for example "last seen 5 min. ago" or "last seen yesterday at 2:30 PM". While there is no data yet, no status is shown.

Separately, the app header has an indicator of your own connection: **connected**, **connecting…**, or **offline**. It describes your device, not the contact.

## Editing messages

You can change a message you have already sent: hover over it (on a phone, tap it) and press the pencil icon to the left of the message. The message text appears in the input field, and above the field you will see **Editing message** with a **Cancel** button. Send the new version with **Send** or Enter; leave the mode with Escape or **Cancel**. If you had already started typing another message, your draft is not lost: it comes back to the field when you leave the mode.

The other person sees the new text with an **edited** note next to the time. An edit replaces the same message and needs a connection to the server: without one it is not sent and the text stays in the input field. They may have read or copied the old text already — an edit does not recall it and does not remove it from the conversation.

Messages sent before editing appeared (the old format) cannot be changed.

## Deleting your own message

You can delete your own message yourself, without asking the other person: hover over it (on a phone, tap it) and press the basket icon next to the pencil. A question appears above the input field; confirm with **Delete** or close the row with **Cancel**.

The text is erased on the server, and a note takes its place for both of you: **You deleted this message** for you and **The other person deleted this message** for them. The chat list shows **Message deleted** instead of the text. You can delete your own delivered message, including in Saved messages; messages that are still sending or failed cannot be deleted. A deletion cannot be undone.

Nothing is guaranteed.

- The other person may have read, copied or photographed the text earlier, and a modified client may have saved it.
- The hosting provider may keep database backups for a limited time, and a dishonest server may have copied the data earlier.
- Metadata stays: who wrote to whom and when, and that the row existed. The content is erased, not the fact of the conversation.
- We do not erase messages of the other person.
- A tab of the other person without a connection shows the stub after it reconnects or the page is reloaded. Clients that did not reload the page (F5) show "could not decrypt the message".

## PIN (optional)

The PIN encrypts the local keys on this device. It is never sent to the server: the server does not know it and cannot check it.

- **What it gives you:** the keys stay on the device but are stored encrypted, and they cannot be opened without the PIN. While the session is locked, someone with access to your browser cannot decrypt the keys or read your history.
- **Honest limits:** the PIN protects you only while the session is locked. It does not protect an unlocked session: once you have entered the PIN, the keys sit in the page memory while you work. The pauses after wrong entries can be bypassed by someone with access to the device's data, so PIN length matters: we recommend at least 8 characters, preferably with letters.
- **Message queue:** enabling the PIN clears the queue of messages that have not been sent yet. The app asks for confirmation and shows how many messages will be deleted.
- **How to enable:** in Profile open **PIN**, tap **Enable PIN**, enter a PIN in the **New PIN** and **Confirm PIN** fields and tap **Set PIN**. The current session keeps working; after you reload the page it is locked, and the app shows **Enter your PIN to unlock** with the **Unlock** button.
- **Change or disable:** in Profile, in the **PIN** section, tap **Change PIN** (the current PIN is required) or **Disable PIN**.
- **Forgot PIN:** tap **Forgot PIN?**, then **End session**. Keys on this device will be erased. To use the account again, sign in with your seed phrase. Messages remain on the server and are restored after you sign in again.
- **Pauses after incorrect entries:** the first four wrong attempts have no pause, after the fifth — a 5-minute pause, after the sixth — 15 minutes, after the seventh and every subsequent — 60 minutes. A successful unlock resets the counter. The minimum PIN length is 6 characters, but that is only a technical minimum.

## Sign out

Tap **Sign out** in Profile. The app asks you to enter this account's seed phrase and checks that it matches, then erases the keys from this device. You can also sign out without checking with **Sign out without checking**, but a warning appears first. Either way, you can sign in again only with your seed phrase, and without it the account is lost forever.

## Language

The interface language is detected automatically from your browser settings. To change it manually, open **Language** and select Russian, English, or Ukrainian. Your choice is saved in the browser.

## Honest limitations

- The server can see who messages whom and when, as well as message length, but not message contents.
- No account recovery. Losing the seed phrase means losing the account.
- There has been no independent security audit. The project is in the testing stage.
- No forward secrecy: if the seed phrase leaks, past conversations can be read too.
- The server is hosted on a free hosting plan. After downtime, the first sign-in may take up to a minute.
- Only text one-to-one messages and web-only for now. No groups, files, calls, or mobile apps.
