import express from "express";
import twilio from "twilio";
import bodyParser from "body-parser";
import OpenAI from "openai";

console.log("📌 Starting server file…");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Railway PORT
const PORT = process.env.PORT || 3000;

// Debug variables
console.log("TWILIO SID:", process.env.TWILIO_SID ? "OK" : "MISSING");
console.log("TWILIO AUTH:", process.env.TWILIO_AUTH ? "OK" : "MISSING");
console.log("OPENAI KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");

// Twilio + OpenAI clients
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (per caller)
const sessions = {}; // { "+6146...": { stage, booking, lastReply } }

// ------------------------------------------------------------
// 🧹 SPEECH CLEANING FUNCTION
// ------------------------------------------------------------
function cleanSpeech(input) {
  if (!input) return "";

  let text = input.toLowerCase();

  text = text.replace(/([a-z])\1{2,}/gi, "");
  text = text.replace(/\b(um+|uh+|erm+|hmm+|huh+|ah+|mmm+)\b/gi, "");
  text = text.replace(/\b(m+|n+|a+)\b/gi, "");
  text = text.replace(/\b([a-z])\1{1,}\b/gi, "");
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

// ------------------------------------------------------------
// 🧍‍♂️ FIXED STRONG NAME EXTRACTION
// ------------------------------------------------------------
function extractName(text) {
  if (!text) return "";

  let t = text.toLowerCase().trim();

  t = t.replace(/\b(hi|hello|hey|good morning|good afternoon|good evening)\b/gi, "");
  t = t.replace(/\b(my name is|i am|i'm|this is|it's|its|the name is|speaking|me speaking)\b/gi, "");
  t = t.replace(/\b(uh+|umm+|erm+|mm+|mmm+|ah+|hmm+)\b/gi, "");
  t = t.replace(/([a-z])\1{2,}/gi, "");
  t = t.replace(/^[^a-z]+/, "").trim();

  let words = t.split(" ")
    .map(w => w.replace(/[^a-z]/gi, ""))
    .filter(w => w.length >= 3);

  if (words.length === 0) return "";

  let name = words[0];
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

// ------------------------------------------------------------
// 🗺️ SUBURB AUTO DETECTION
// ------------------------------------------------------------
function extractSuburb(input) {
  if (!input) return "";

  let text = input.toLowerCase().trim();

  text = text.replace(/\b(i'm|i am|im|in|at|from|my suburb is|suburb is|it's|its|the suburb is|i live in|live in)\b/gi, "");
  text = text.replace(/\b(um+|uh+|erm+|mmm+|hmm+|ah+|nn+)\b/gi, "");
  text = text.replace(/([a-z])\1{2,}/gi, "$1");
  text = text.replace(/\b(m+|n+|a+)\b/gi, "");

  return text
    .split(" ")
    .filter(w => w.length > 0)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ------------------------------------------------------------
// TIME + DATE FUNCTIONS
// ------------------------------------------------------------
function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateAU(date) {
  return date.toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
}

function formatTimeDisplay(hour, minute, ampm) {
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  if (!ampm) return hour + ":" + pad(minute);

  const ampmLower = ampm.toLowerCase();
  let h24 = hour;
  if (ampmLower === "pm" && hour < 12) h24 = hour + 12;
  if (ampmLower === "am" && hour === 12) h24 = 0;

  const displayHour = ((h24 + 11) % 12) + 1;
  return displayHour + ":" + pad(minute) + " " + ampmLower;
}

function extractTime(input) {
  if (!input) return "";

  let text = input.toLowerCase().trim();
  text = text.replace(/\b(um+|uh+|erm+|mmm+|hmm+|ah+|nn+)\b/gi, "");

  const now = new Date();
  let baseDate = null;
  let partOfDay = "";
  let timeString = "";

  if (text.includes("morning")) partOfDay = "morning";
  else if (text.includes("afternoon")) partOfDay = "afternoon";
  else if (text.includes("evening")) partOfDay = "evening";
  else if (text.includes("tonight")) partOfDay = "tonight";
  else if (text.includes("lunch")) partOfDay = "around lunch";

  if (text.includes("day after tomorrow")) baseDate = addDays(now, 2);
  else if (text.includes("tomorrow")) baseDate = addDays(now, 1);
  else if (text.includes("today")) baseDate = now;

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const todayIndex = now.getDay();

  if (!baseDate) {
    for (let i = 0; i < 7; i++) {
      if (text.includes("next " + weekdays[i])) {
        let diff = (i - todayIndex + 7) % 7;
        if (diff === 0) diff = 7;
        baseDate = addDays(now, diff + 7);
        break;
      }
    }
  }

  if (!baseDate) {
    for (let i = 0; i < 7; i++) {
      if (text.includes(weekdays[i])) {
        let diff = (i - todayIndex + 7) % 7;
        if (diff === 0) diff = 7;
        baseDate = addDays(now, diff);
        break;
      }
    }
  }

  const dateMatch = text.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
  if (!baseDate && dateMatch) {
    let dayNum = parseInt(dateMatch[1]);
    let month = now.getMonth();
    let year = now.getFullYear();
    let candidate = new Date(year, month, dayNum);
    if (candidate < now) {
      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
      candidate = new Date(year, month, dayNum);
    }
    baseDate = candidate;
  }

  const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/) || text.match(/\b(\d{3,4})\b/);

  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    let minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    let ampm = timeMatch[3] || null;

    if (!ampm) {
      if (partOfDay === "evening") ampm = "pm";
      else if (partOfDay === "morning") ampm = "am";
    }

    if (!timeMatch[3] && timeMatch[0].length === 4 && !timeMatch[2]) {
      const str = timeMatch[0];
      hour = parseInt(str.slice(0, 2));
      minute = parseInt(str.slice(2));
    }

    timeString = formatTimeDisplay(hour, minute, ampm);
  }

  if (baseDate && timeString)
    return formatDateAU(baseDate) + " at " + timeString;

  if (baseDate && partOfDay)
    return formatDateAU(baseDate) + " " + partOfDay;

  if (baseDate) return formatDateAU(baseDate);

  if (timeString && partOfDay)
    return timeString + " (" + partOfDay + ")";

  if (timeString) return "at " + timeString;

  if (partOfDay) return partOfDay;

  return text;
}

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Handyman AI Voice server is running.");
});

// ------------------------------------------------------------
// SESSION HANDLING
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
// FIRST GREETING (fixed gather)
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);
    session.stage = "ask_name";

    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      input: "speech",
      action: "/gather",
      method: "POST",
      language: "en-AU",
      speechTimeout: 1.5,
      timeout: 8,
      hints: "my name is, i am, this is"
    });

    gather.say(
      { voice: "alice", language: "en-AU" },
      "Hi, you’ve reached Barish’s handyman line. Can I grab your first name?"
    );

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("❌ Error in /voice:", err);
    res.send("<Response><Say>Sorry, something went wrong.</Say></Response>");
  }
});

// ------------------------------------------------------------
// 🔥 GLOBAL VOICE RECORDING ENDPOINT (Option A)
// ------------------------------------------------------------
app.post("/saveRecording", async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || "";
  const from = req.body.From || "";

  console.log("🎤 Recording URL:", recordingUrl);

  if (recordingUrl) {
    await saveToGoogleSheet({
      phone: from,
      recording: recordingUrl + ".mp3",
      stage: "job_recording"
    });

    client.messages.create({
      from: "+61468067099",
      to: "+61404983231",
      body: `New job voice message:\n${recordingUrl}.mp3`
    });
  }

  res.send("OK");
});

// ------------------------------------------------------------
// MAIN GATHER LOGIC
// ------------------------------------------------------------
app.post("/gather", async (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);

    const userSpeechRaw = req.body.SpeechResult || "";
    const cleaned = cleanSpeech(userSpeechRaw);
    const userSpeech = cleaned.toLowerCase();

    const twiml = new twilio.twiml.VoiceResponse();

    // --------------------------------------------------------
    // REPEAT HANDLING
    // --------------------------------------------------------
    if (
      userSpeech.includes("repeat") ||
      userSpeech.includes("say again") ||
      userSpeech.includes("sorry") ||
      userSpeech.includes("pardon") ||
      userSpeech.includes("didn't catch") ||
      userSpeech.includes("didnt catch")
    ) {
      const toRepeat = session.lastReply || "Let me say that again more clearly.";

      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Sure, no worries. " + toRepeat
      );

      const gather = twiml.gather({
        input: "speech",
        action: "/gather",
        method: "POST",
        language: "en-AU",
        speechTimeout: 1.5,
        timeout: 6
      });

      gather.say({ voice: "alice", language: "en-AU" }, "");

      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // --------------------------------------------------------
    // BOOKING FLOW
    // --------------------------------------------------------
    let reply = "";
    const b = session.booking;

    switch (session.stage) {

      // NAME
      case "ask_name": {
        const name = extractName(cleaned);

        console.log("🟩 Extracted name:", name);

        if (!name || name.length < 2) {
          reply = "Sorry, I didn't catch your name. Could you say just your first name?";
          break;
        }

        b.name = name;
        session.stage = "ask_job";

        reply = `Nice to meet you, ${name}. What do you need a hand with today?`;
        break;
      }

      // JOB (recording)
      case "ask_job":

        twiml.record({
          recordingStatusCallback: "/saveRecording",
          playBeep: false,
          timeout: 1.5,
          maxLength: 12
        });

        if (cleaned.trim().length < 8) {
          reply = "Could you please tell me a bit more about the job?";
          break;
        }

        b.job = cleaned.trim();
        session.stage = "ask_suburb";
        reply = "Thanks for the details. Which suburb are you in?";
        break;

      // SUBURB
      case "ask_suburb": {
        const suburb = extractSuburb(cleaned);

        if (!suburb || suburb.length < 2) {
          reply = "Sorry, I didn't catch that, what suburb are you in?";
          break;
        }

        b.suburb = suburb;
        session.stage = "ask_time";

        reply = "Thanks. When would you like us to come out?";
        break;
      }

      // TIME
      case "ask_time": {
        const timeValue = extractTime(cleaned);

        if (!timeValue) {
          reply = "Sorry, when would you like us to come out?";
          break;
        }

        b.time = timeValue;
        session.stage = "confirm";

        reply = "Thanks. Can I confirm the booking — is everything you said correct?";
        break;
      }

      // CONFIRM
      case "confirm": {

        if (
          userSpeech.includes("yes") ||
          userSpeech.includes("yeah") ||
          userSpeech.includes("yep") ||
          userSpeech.includes("sure") ||
          userSpeech.includes("correct")
        ) {
          session.stage = "completed";

          await saveToGoogleSheet({
            phone: b.phone,
            name: b.name,
            job: b.job,
            suburb: b.suburb,
            time: b.time,
            stage: "completed"
          });

          reply =
            `Perfect, ${b.name}. I'll send you a text with your booking details now. Thanks for calling.`;

          const customerBody =
            `Thanks for calling Barish’s Handyman Desk.
Booking details:
Name: ${b.name}
Job: ${b.job}
Suburb: ${b.suburb}
Preferred time: ${b.time}
We’ll be in touch shortly.`;

          const ownerBody =
            `New handyman enquiry:
From: ${b.name} (${b.phone})
Job: ${b.job}
Suburb: ${b.suburb}
Preferred time: ${b.time}`;

          try {
            if (from !== "unknown") {
              client.messages.create({
                from: "+61468067099",
                to: from,
                body: customerBody
              });
            }

            client.messages.create({
              from: "+61468067099",
              to: "+61404983231",
              body: ownerBody
            });
          } catch (err) {
            console.error("❌ SMS error:", err.message);
          }

        } else if (userSpeech.includes("no")) {
          session.stage = "ask_job";
          reply = "No worries, what do you need help with?";
        } else {
          reply = "Sorry, is that booking correct?";
        }
        break;
      }

      // DONE
      case "completed":
        reply =
          "Thanks again for calling Barish’s handyman line. Have a great day!";
        break;

      default:
        reply = "Sorry, I didn’t catch that. Could you say it again?";
    }

    // SPEAK reply
    session.lastReply = reply;
    twiml.say({ voice: "alice", language: "en-AU" }, reply);

    // END OR CONTINUE
    if (session.stage === "completed") {
      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Bye for now!"
      );
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: "speech",
        action: "/gather",
        method: "POST",
        language: "en-AU",
        speechTimeout: 1.5,
        timeout: 10
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

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);

// ------------------------------------------------------------
// GOOGLE SHEETS SETUP
// ------------------------------------------------------------
import { google } from "googleapis";

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
      new Date().toLocaleString("en-AU"),
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
