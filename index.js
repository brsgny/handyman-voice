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

  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You are a warm, friendly Aussie receptionist. Speak slowly, clearly, and use a calm tone. Keep replies under two short sentences. Ask only one question at a time."
      },
      {
        role: "user",
        content: userSpeech || "The caller did not say anything."
      }
    ]
  });

  const aiReply = completion.choices[0].message.content;

  const twiml = new twilio.twiml.VoiceResponse();

  // Say AI response
  twiml.say({ voice: "alice", language: "en-AU" }, aiReply);

  // Continue the conversation without going back to greeting
  const nextGather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    language: "en-AU",
    speechTimeout: 2,
    timeout: 10
  });

  nextGather.say(
    { voice: "alice", language: "en-AU" },
    "How else can I help you?"
  );

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(3000, () => console.log("Server running on port 3000"));

