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

// Memory for repeating last message
let lastReply = "";

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
      "Hi, this is Barish’s phone number. How can I help you today?"
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
    const userSpeechRaw = req.body.SpeechResult || "";
    const userSpeech = userSpeechRaw.toLowerCase();
    console.log("🗣 User said:", userSpeechRaw);

    const twiml = new twilio.twiml.VoiceResponse();

    // ----------------------------------------------------
    // REPEAT HANDLING (caller didn't understand)
    // ----------------------------------------------------
    if (
      userSpeech.includes("repeat") ||
      userSpeech.includes("say again") ||
      userSpeech.includes("pardon") ||
      userSpeech.includes("sorry") ||
      userSpeech.includes("didn't catch") ||
      userSpeech.includes("didnt catch") ||
      userSpeech.includes("what")
    ) {
      const toRepeat = lastReply || "Let me say that again.";
      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Sure, no worries… " + toRepeat
      );

      const gather = twiml.gather({
        input: "speech",
        action: "/gather",
        method: "POST",
        language: "en-AU",
        speechTimeout: 2,
        timeout: 8
      });

      gather.say({ voice: "alice", language: "en-AU" }, "");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // ----------------------------------------------------
    // NORMAL OPENAI RESPONSE
    // ----------------------------------------------------
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a warm, calm Aussie receptionist for a handyman service. Speak slowly, clearly, and conversationally. Use short, simple sentences. Avoid sounding robotic. If caller is confused, gently repeat or explain again. Do NOT say 'what would you like me to repeat'. Keep replies friendly, helpful, and natural."
        },
        { role: "user", content: userSpeechRaw }
      ]
    });

    const aiReply = completion.choices[0].message.content.trim();
    lastReply = aiReply; // save for repeating

    // Speak reply
    twiml.say({ voice: "alice", language: "en-AU" }, aiReply);

    // ----------------------------------------------------
    // END CALL DETECTION
    // ----------------------------------------------------
    if (
      userSpeech.includes("bye") ||
      userSpeech.includes("thanks") ||
      userSpeech.includes("that’s all") ||
      userSpeech.includes("that's all") ||
      userSpeech.includes("no more")
    ) {
      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Thanks for calling. Have a lovely day."
      );
    } else {
      // Continue conversation
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
