
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Twilio sends x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// In-memory conversation store per call.
// For production you might use Redis or a DB instead.
const callMemory = new Map();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Build / update conversation history for this CallSid
 */
function buildMessages(callSid, userText) {
  const systemPrompt = `
You are an AI phone receptionist for a handyman business in Australia.

Your role:
- Answer the phone in a friendly, professional, down‑to‑earth Aussie style.
- Quickly find out:
  * What the job is (e.g. painting, door repair, flat pack install, TV mounting, leaking tap, etc.)
  * Where the job is (suburb and rough address)
  * When the customer would like it done (give a couple of time window options)
- Ask follow–up questions only if needed.
- Give realistic price ranges, not exact quotes. Use rough wording like:
  "Most jobs like this land between 150 and 350 dollars, depending on details."
- Keep sentences short and clear – this will be converted to text‑to‑speech.
- At the end, summarise the booking details and ask:
  "Is that all correct?"
- If the caller seems finished, say goodbye politely and let them hang up.

Never mention that you are an AI or language model unless the caller explicitly asks.
  `.trim();

  let history = callMemory.get(callSid);
  if (!history) {
    history = [{ role: 'system', content: systemPrompt }];
  }

  if (userText && userText.trim()) {
    history.push({ role: 'user', content: userText.trim() });
  }

  callMemory.set(callSid, history);
  return history;
}

/**
 * Call OpenAI to generate the assistant reply
 */
async function getAssistantReply(messages) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages,
    temperature: 0.6,
  });

  let content = response.choices[0].message.content;

  // Newer SDKs may return content as an array of blocks
  if (Array.isArray(content)) {
    content = content.map(part => part.text || '').join(' ');
  }

  return content;
}

/**
 * Entry webhook: when a call first comes in
 */
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.gather({
    input: 'speech',
    action: '/gather',
    method: 'POST',
    language: 'en-AU',
    timeout: 5,
  }).say(
    {
      voice: 'alice',
      language: 'en-AU',
    },
    'Hi, this is the handyman desk. How can we help you today?'
  );

  // Fallback if no speech captured
  twiml.say(
    {
      voice: 'alice',
      language: 'en-AU',
    },
    'Sorry, I did not catch that. Please call again later. Bye for now.'
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Second webhook: Twilio sends us what the caller said
 */
app.post('/gather', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';
  const fromNumber = req.body.From;
  const toNumber = req.body.To;

  console.log('Incoming speech:', {
    callSid,
    fromNumber,
    toNumber,
    speechResult,
  });

  if (!speechResult.trim()) {
    twiml.say(
      {
        voice: 'alice',
        language: 'en-AU',
      },
      'Sorry, I did not catch anything there.'
    );
    twiml.pause({ length: 1 });
    twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      language: 'en-AU',
      timeout: 5,
    }).say(
      {
        voice: 'alice',
        language: 'en-AU',
      },
      'Please tell me what you need help with.'
    );

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    // Build messages and call OpenAI
    const messages = buildMessages(callSid, speechResult);
    const assistantReply = await getAssistantReply(messages);

    // Save assistant message into history
    messages.push({ role: 'assistant', content: assistantReply });
    callMemory.set(callSid, messages);

    // Read the AI reply back to the caller
    twiml.say(
      {
        voice: 'alice',
        language: 'en-AU',
      },
      assistantReply
    );

    // Ask if they need anything else
    twiml.pause({ length: 0.5 });
    twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      language: 'en-AU',
      timeout: 6,
    }).say(
      {
        voice: 'alice',
        language: 'en-AU',
      },
      'If you need anything else, just say it after the beep. Otherwise, you can hang up now.'
    );

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('Error calling OpenAI:', err);
    twiml.say(
      {
        voice: 'alice',
        language: 'en-AU',
      },
      'Sorry, there was a technical problem on our side. Please try again later.'
    );
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

app.get('/', (_req, res) => {
  res.send('Handyman AI Voice server is running.');
});

app.listen(port, () => {
  console.log(`Handyman Voice AI server listening on port ${port}`);
});
