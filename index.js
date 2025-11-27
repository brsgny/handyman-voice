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

// MAIN ANSWER
app.post("/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    language: "en-AU",
    speechTimeout: "auto"
  });

  gather.say({
    voice: "alice",
    language: "en-AU"
  }, "Hi, this is the handyman desk. How can we help you today?");

  res.type("text/xml");
  res.send(twiml.toString());
});

// HANDLE SPEECH
app.post("/gather", async (req, res) => {
  const userSpeech = req.body.SpeechResult;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a friendly Aussie receptionist helping customers with handyman jobs." },
      { role: "user", content: userSpeech || "No speech detected" }
    ]
  });

  const aiReply = response.choices[0].message.content;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: "alice", language: "en-AU" }, aiReply);
  twiml.redirect("/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

app.listen(3000, () => console.log("Server running on port 3000"));
