import express from "express";
import twilio from "twilio";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { google } from "googleapis";

console.log("📌 Starting server file…");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Railway PORT
const PORT = process.env.PORT || 3000;

// Debug variables
console.log("TWILIO SID:", process.env.TWILIO_SID ? "OK" : "MISSING");
console.log("TWILIO AUTH:", process.env.TWILIO_AUTH ? "OK" : "MISSING");
console.log("OPENAI KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");

// Twilio client
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory caller sessions
const sessions = {}; 

// ------------------------------------------------------------
// GOOGLE SHEETS SETUP
// ------------------------------------------------------------
const auth = new google.auth.JWT(
  process.env.GOOGLE_SA_EMAIL,
  null,
  process.env.GOOGLE_SA_KEY.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

async function saveToGoogleSheet(data) {
  try {
    const values = [[
      new Date().toLocaleString("en-AU", { timeZone: "Australia/Melbourne" }),
      data.phone || "",
      data.name || "",
      data.job || "",
      data.suburb || "",
      data.time || "",
      data.recording || "",
      data.stage || ""
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "Sheet1!A:H",
      valueInputOption: "RAW",
      resource: { values }
    });

    console.log("📄 Google Sheet UPDATED");
  } catch (err) {
    console.error("❌ Google Sheets Error:", err);
  }
}

// ------------------------------------------------------------
// METHODS
// ------------------------------------------------------------
function cleanSpeech(input) {
  if (!input) return "";
  let text = input.toLowerCase();
  text = text.replace(/([a-z])\1{2,}/gi, "");
  text = text.replace(/\b(um+|uh+|erm+|mmm+|hmm+|ah+)\b/gi, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function extractName(text) {
  if (!text) return "";
  let t = text.toLowerCase();
  t = t.replace(/\b(hi|hello|hey|good morning|good afternoon)\b/gi, "");
  t = t.replace(/\b(i am|i'm|my name is|this is|speaking)\b/gi, "");
  t = t.trim();
  let first = t.split(" ")[0];
  first = first.replace(/[^a-z]/gi, "");
  if (first.length < 2) return "";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function extractSuburb(t) {
  if (!t) return "";
  t = t.toLowerCase();
  t = t.replace(/\b(i am|i'm|in|at|from|suburb is|i live in)\b/gi, "");
  t = t.trim();
  return t.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ------------------------------------------------------------
// GET/CREATE SESSION
// ------------------------------------------------------------
function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      stage: "ask_name",
      booking: {
        phone: from,
        name: "",
        job: "",
        suburb: "",
        time: ""
      },
      lastReply: ""
    };
  }
  return sessions[from];
}

// ------------------------------------------------------------
// SAVE RECORDING CALLBACK
// ------------------------------------------------------------
app.post("/saveRecording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || "";
  const from = req.body.From || "";
  console.log("🎤 Recording URL:", recordingUrl);

  if (recordingUrl) {
    await saveToGoogleSheet({
      phone: from,
      recording: recordingUrl,
      stage: "job_recording"
    });

    // Send SMS to handyman
    await client.messages.create({
      from: "+61468067099",
      to: "+61404983231",
      body: `New job voice message:\n${recordingUrl}.mp3`
    });
  }

  res.send("OK");
});

// ------------------------------------------------------------
// START - FIRST CALL
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  const from = req.body.From || "unknown";
  const session = getSession(from);
  session.stage = "ask_name";

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/gather",
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
    language: "en-AU"
  });

  gather.say("Hi, you’ve reached Barish’s handyman line. Can I grab your first name?");

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// GATHER HANDLER
// ------------------------------------------------------------
app.post("/gather", async (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);
    const b = session.booking;

    const cleaned = cleanSpeech(req.body.SpeechResult || "");
    const userSpeech = cleaned.toLowerCase();

    const twiml = new twilio.twiml.VoiceResponse();
    let reply = "";

    switch (session.stage) {

      // -------------------------
      case "ask_name":
        const name = extractName(cleaned);
        if (!name) {
          reply = "Sorry, I didn't catch your name. Please say just your first name.";
          break;
        }
        b.name = name;
        session.stage = "ask_job";
        reply = `Nice to meet you ${name}. What job do you need help with today?`;
        break;

      // -------------------------
      case "ask_job":
        if (cleaned.length < 5) {
          reply = "Could you tell me a little more about the job?";
          break;
        }

        b.job = cleaned;
        session.stage = "record_job_detail";

        reply = "Thanks. I will now record a short message so our handyman can hear exactly what you need.";
        break;

      // -------------------------
      case "record_job_detail": {
        const recordTwiml = new twilio.twiml.VoiceResponse();

        recordTwiml.say("Please describe the job after the beep.");
        recordTwiml.record({
          action: "/recording-complete",
          recordingStatusCallback: "/saveRecording",
          playBeep: true,
          maxLength: 30,
          trim: "trim-silence"
        });
        recordTwiml.say("Thanks, that has been recorded.");
        recordTwiml.hangup();

        res.type("text/xml");
        return res.send(recordTwiml.toString());
      }

      // -------------------------
      case "ask_suburb":
        const suburb = extractSuburb(cleaned);
        if (!suburb) {
          reply = "Which suburb are you in?";
          break;
        }
        b.suburb = suburb;
        session.stage = "ask_time";
        reply = "Thanks. When would you like us to come out?";
        break;

      // -------------------------
      case "ask_time":
        b.time = cleaned;
        session.stage = "confirm";
        reply = `So I have ${b.job} in ${b.suburb} at ${b.time}. Is that correct?`;
        break;

      // -------------------------
      case "confirm":
        if (userSpeech.includes("yes") || userSpeech.includes("yeah")) {
          session.stage = "completed";

          await saveToGoogleSheet({
            phone: b.phone,
            name: b.name,
            job: b.job,
            suburb: b.suburb,
            time: b.time,
            stage: "completed"
          });

          reply = `Perfect, ${b.name}. I'll send you a text with your booking details now. Thanks for calling.`;

          // SEND SMS
          const ownerMsg = 
            `New enquiry:\nName: ${b.name}\nPhone: ${b.phone}\nJob: ${b.job}\nSuburb: ${b.suburb}\nTime: ${b.time}`;

          await client.messages.create({
            from: "+61468067099",
            to: "+61404983231",
            body: ownerMsg
          });

        } else {
          session.stage = "ask_job";
          reply = "No worries — what job do you need done?";
        }
        break;

      // -------------------------
      case "completed":
        reply = "Thanks again for calling. Have a great day!";
        twiml.say(reply);
        twiml.hangup();
        res.type("text/xml");
        return res.send(twiml.toString());
    }

    // DEFAULT SPEAK REPLY
    session.lastReply = reply;
    twiml.say(reply);

    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
      language: "en-AU"
    });

    gather.say("");

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error(err);
    res.send("<Response><Say>Sorry, something went wrong.</Say></Response>");
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
