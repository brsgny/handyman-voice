import express from "express";
import twilio from "twilio";
import bodyParser from "body-parser";
import OpenAI from "openai";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/", (req, res) => {
  res.send("Handyman AI Voice server is running.");
});

// FIRST GREETING (only once)
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    language: "en-AU",
    speechTimeout: 2,  // waits after caller stops speaking
    timeout: 10        // caller has 10 seconds to start talking
  });

  gather.say(
    { voice: "alice", language: "en-AU" },
    "Hi, this is Barish`s phone. How can I help you today?"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

// MAIN CONVERSATION LOOP
app.post("/gather", async (req, res) => {
  const userSpeech = req.body.SpeechResult || "";

  console.log("User said:", userSpeech);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a warm, calm Aussie receptionist for a handyman service.
Speak slowly, naturally and conversationally — like a real person on the phone.
Use 1–2 short sentences, with occasional pauses (use '...' to pace your speech).
DO NOT repeat yourself.
DO NOT ask "How else can I help you?" every time.
Only ask a follow-up question when needed to progress the conversation.
If the caller sounds done, say something like:
"Is there anything else you'd like a hand with today?"
If they say no, finish politely.
Keep the tone relaxed, friendly and helpful.
        `
      },
      { role: "user", content: userSpeech }
    ]
  });

  const aiReply = completion.choices[0].message.content;

  const twiml = new twilio.twiml.VoiceResponse();

  // Say the AI reply
  twiml.say({ voice: "alice", language: "en-AU" }, aiReply);

  // Decide whether to gather again
  if (!/bye|thanks|thank you|no that’s all|that's all/i.test(userSpeech)) {
    const next = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      language: "en-AU",
      speechTimeout: 2,
      timeout: 8   // shorter pause feels more natural
    });

    // Light, soft follow-up BEHIND THE SCENES (not repeating the question)
    next.say(
      { voice: "alice", language: "en-AU" },
      ""
    );
  } else {
    twiml.say(
      { voice: "alice", language: "en-AU" },
      "Thanks for calling. Have a lovely day."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});
