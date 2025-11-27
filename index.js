import express from "express";
import twilio from "twilio";
import bodyParser from "body-parser";
import OpenAI from "openai";

console.log("📌 Starting server file…");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Railway PORT fix
const PORT = process.env.PORT || 3000;

// Debug variables
console.log("TWILIO SID:", process.env.TWILIO_SID ? "OK" : "MISSING");
console.log("OPENAI KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Health check
app.get("/", (req, res) => {
  res.send("Handyman AI Voice server is running.");
});

// FIRST GREETING
app.post("/voice", (req, res) => {
  try {
    console.log("📞 /voice endpoint hit");

    const twiml = new twilio.twiml.VoiceResponse();

    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      language: "en-AU",
      speechTimeout: 2,
      timeout: 10
    });

    gather.say(
      { voice: "alice", language: "en-AU" },
      "Hi, this is the handyman desk. How can I help you today?"
    );

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("❌ Error in /voice:", err);
    res.send("<Response><Say>Sorry, something went wrong.</Say></Response>");
  }
});

// MAIN LOOP
app.post("/gather", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult || "";
    console.log("🗣 User said:", userSpeech);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
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
    twiml.say({ voice: "alice", language: "en-AU" }, aiReply);

    // End call detection
    if (/bye|thanks|that’s all|no more/i.test(userSpeech)) {
      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Thanks for calling. Have a lovely day."
      );
    } else {
      const gather = twiml.gather({
        input: "speech",
        action: "/gather",
        method: "POST",
        language: "en-AU",
        speechTimeout: 2,
        timeout: 8
      });

      gather.say({ voice: "alice", language: "en-AU" }, "");
    }

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("❌ Error in /gather:", err);
    res.type("text/xml");
    res.send("<Response><Say>Sorry, I'm having trouble right now.</Say></Response>");
  }
});

// START SERVER
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
