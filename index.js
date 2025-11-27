require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// Twilio sends x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: false }));

// Memory store for each call
const callMemory = new Map();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Build AI conversation history for this call
 */
function buildMessages(callSid, userText) {
  const systemPrompt = `
You are an AI phone receptionist for a handyman business in Australia.

Your role:
- Answer in a friendly Aussie tone.
- Ask what job they need done (painting, leaking tap, door repair, TV mounting, etc).
- Ask where the job is (suburb + rough address).
- Ask when they want it done; offer simple time options.
- Give rough price ranges only ("jobs like this usually land between 150 and 350 dollars").
- Keep responses short and clear.
- Summarise all details near the end and confirm accuracy.
- If caller is finished, say goodbye politely.
`;

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
 * Ask OpenAI for a response
 */
async function getAssistantReply(messages) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages,
    temperature: 0.6,
  });

  let content = response.choices[0].message.content;

  // SDK variations
  if (Array.isArray(content)) {
    content = content.map(part => part.text || '').join(' ');
  }

  return content;
}

/**
 * FIRST Webhook: /voice — when the call starts
 */
app.post('/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    action: '/gather',
    method: 'POST',
    language: 'en-AU',
    timeout: 5,
  });

  gather.say(
    {
      voice: 'alice',
      language: 'en-AU',
    },
    'Hi, this is the handyman desk. How can we help you today?'
  );

  // ❗ IMPORTANT: no fallback say here
  // ❗ Do NOT add anything after gather

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * SECOND Webhook: /gather — user has spoken
 */
app.post('/gather', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';

  console.log("User said:", speechResult);

  if (!speechResult.trim()) {
    // Ask again politely
    const retry = twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      timeout: 5,
      language: 'en-AU',
    });

    retry.say(
      { voice: 'alice', language: 'en-AU' },
      'Sorry mate, didn’t catch that. What do you need help with?'
    );

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    // Build conversation and get AI reply
    const messages = buildMessages(callSid, speechResult);
    const assistantReply = await getAssistantReply(messages);

    messages.push({ role: 'assistant', content: assistantReply });
    callMemory.set(callSid, messages);

    // Speak AI reply
    twiml.say(
      { voice: 'alice', language: 'en-AU' },
      assistantReply
    );

    // Ask if they need anything else
    const gatherMore = twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      timeout: 6,
      language: 'en-AU',
    });

    gatherMore.say(
      { voice: 'alice', language: 'en-AU' },
      'If you need anything else, just tell me. Otherwise you can hang up.'
    );

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error("OpenAI error:", err);

    twiml.say(
      { voice: 'alice', language: 'en-AU' },
      'Sorry mate, something went wrong on our end. Please try again shortly.'
    );

    res.type('text/xml');
    res.send(twiml.toString());
  }
});

/**
 * Sanity Check Root Route
 */
app.get('/', (_req, res) => {
  res.send('Handyman AI Voice server is running.');
});

/**
 * Start server
 */
app.listen(port, "0.0.0.0", () => {
  console.log(`Handyman Voice AI server listening on port ${port}`);
});
