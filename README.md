
# Handyman AI Voice Receptionist (Twilio + OpenAI)

This is a ready-to-deploy Node.js server that turns your Twilio phone number into
an AI voice receptionist for your handyman business.

The flow:

> Caller → Twilio Number → This Server → OpenAI → Twilio text-to-speech reply

It uses **Twilio speech recognition** (no streaming audio setup required) and
**OpenAI chat completions** to generate natural responses.

---

## 1. Requirements

- Node.js 18 or later
- An OpenAI API key
- A Twilio account with a purchased phone number
- (Optional) Ngrok for local testing

---

## 2. Install locally

```bash
cd handyman-voice
npm install
cp .env.example .env
```

Edit `.env` and put your real OpenAI key:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
PORT=3000
```

Start the server:

```bash
npm start
```

You should see:

```text
Handyman Voice AI server listening on port 3000
```

---

## 3. Expose your server to Twilio (local testing)

If you want to test from your own machine, use **ngrok**:

```bash
ngrok http 3000
```

Ngrok will give you a URL like:

```text
https://random-subdomain.ngrok.io
```

Keep this handy.

---

## 4. Connect Twilio Number → This Server

1. Go to **Twilio Console → Phone Numbers → Manage → Active Numbers**  
2. Click your **handyman number**  
3. Scroll to **Voice & Fax** section  
4. Under **Voice Configuration**:

   - **A CALL COMES IN** → choose **Webhook**  
   - **URL** → put:

     ```text
     https://YOUR-SERVER-URL/voice
     ```

     Examples:
     - Local with ngrok: `https://random-subdomain.ngrok.io/voice`
     - Render/Railway: `https://your-app.onrender.com/voice`

   - **Method** → `HTTP POST`

5. Click **Save**.

Now whenever a call comes in, Twilio sends it to `/voice` and the server
responds with TwiML that:

- Greets the caller
- Captures what they say (speech-to-text)
- Sends the transcript to OpenAI
- Reads the AI answer back with **Twilio <Say>** using the Aussie voice.

---

## 5. Deploy to Render / Railway

### Option A – Render

1. Create a new **Web Service** on Render
2. Connect this project (upload or push to GitHub)
3. Set:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Add environment variables in Render dashboard:

   - `OPENAI_API_KEY` → your real key
   - `OPENAI_MODEL` → `gpt-4.1-mini` (or another)
   - `PORT` → `3000`

5. Deploy. Render will give you a URL like:

   ```text
   https://handyman-voice.onrender.com
   ```

6. Put this in Twilio:

   ```text
   https://handyman-voice.onrender.com/voice
   ```

### Option B – Railway

Similar steps:

1. New Project → Deploy from Repo / Zip
2. Set environment variables
3. Use `npm start` as start command
4. Use the Railway URL + `/voice` in Twilio.

---

## 6. How it works (high level)

- `/voice`  
  First webhook when call comes in. Responds with **TwiML**:

  - Greets the caller
  - Uses `<Gather input="speech">` to capture spoken text
  - Sends it to `/gather`

- `/gather`  
  Twilio posts back `{ SpeechResult: "...caller words..." }`.

  Steps:

  1. We log the text and append it to conversation history for this `CallSid`
  2. We send the conversation to OpenAI (`chat.completions.create`)
  3. We get the assistant reply (short, clear)
  4. We read it back via `<Say>`
  5. We ask if they need anything else using another `<Gather>`

This repeats until the caller hangs up.

---

## 7. Customise the personality

Inside `index.js`, look for `systemPrompt` in `buildMessages()`.

You can change tone, pricing rules, suburb handling, etc. For example:

- Emphasise emergency jobs.
- Mention call‑out fee.
- Ask for email for sending quote.
- Tie into SMS workflows via Twilio (extra endpoints).

---

## 8. Production tips

- This demo stores conversation in **memory** using `callMemory`.
  On a single server instance it’s fine, but if you scale horizontally use
  a shared store (Redis, database, etc.).
- Keep responses short; long paragraphs are slow to speak.
- You can switch `OPENAI_MODEL` to a larger model if you want more reasoning.

---

That’s it — once you point your Twilio number at `/voice`, you have
a working handyman AI phone receptionist.
