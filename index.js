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

  // Remove long repeated characters
  text = text.replace(/([a-z])\1{2,}/gi, "");

  // Remove hesitation/filler words
  text = text.replace(/\b(um+|uh+|erm+|hmm+|huh+|ah+|mmm+)\b/gi, "");

  // Remove isolated noise syllables
  text = text.replace(/\b(m+|n+|a+)\b/gi, "");

  // Remove double-letter noises inside sentences
  text = text.replace(/\b([a-z])\1{1,}\b/gi, "");

  // Remove extra spaces
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

// ------------------------------------------------------------
// 🗺️ SUBURB AUTO DETECTION
// ------------------------------------------------------------
function extractSuburb(input) {
  if (!input) return "";

  let text = input.toLowerCase().trim();

  // Remove leading phrases
  text = text
    .replace(
      /\b(i'm|i am|im|in|at|from|my suburb is|suburb is|it's|its|the suburb is|i live in|live in)\b/gi,
      ""
    )
    .trim();

  // Remove filler
  text = text.replace(/\b(um+|uh+|erm+|mmm+|hmm+|ah+|nn+)\b/gi, "").trim();

  // Remove repeated letters (crraaigieburn -> craigieburn)
  text = text.replace(/([a-z])\1{2,}/gi, "$1");

  // Clean remaining noise syllables
  text = text.replace(/\b(m+|n+|a+)\b/gi, "").trim();

  // Capitalize each word
  return text
    .split(" ")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ------------------------------------------------------------
// ⏰ DATE/TIME HELPERS
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

  if (!ampm) {
    return hour + ":" + pad(minute);
  }

  const ampmLower = ampm.toLowerCase();
  let h24 = hour;
  if (ampmLower === "pm" && hour < 12) h24 = hour + 12;
  if (ampmLower === "am" && hour === 12) h24 = 0;

  const displayHour = ((h24 + 11) % 12) + 1;
  return displayHour + ":" + pad(minute) + " " + ampmLower;
}

// ------------------------------------------------------------
// ⏰ TIME + DATE AUTO DETECTION
// ------------------------------------------------------------
function extractTime(input) {
  if (!input) return "";

  let text = input.toLowerCase().trim();

  // Remove filler
  text = text.replace(/\b(um+|uh+|erm+|mmm+|hmm+|ah+|nn+)\b/gi, "").trim();

  const now = new Date();
  let baseDate = null;
  let partOfDay = "";
  let timeString = "";

  // Parts of day
  if (text.includes("morning")) partOfDay = "morning";
  else if (text.includes("afternoon")) partOfDay = "afternoon";
  else if (text.includes("evening")) partOfDay = "evening";
  else if (text.includes("tonight")) partOfDay = "tonight";
  else if (text.includes("lunch")) partOfDay = "around lunch";

  // Relative days
  if (text.includes("day after tomorrow")) {
    baseDate = addDays(now, 2);
  } else if (text.includes("tomorrow")) {
    baseDate = addDays(now, 1);
  } else if (text.includes("today")) {
    baseDate = addDays(now, 0);
  }

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];
  const todayIndex = now.getDay();

  // Weekdays with "next ..."
  if (!baseDate) {
    for (let i = 0; i < weekdays.length; i++) {
      const day = weekdays[i];
      if (text.includes("next " + day)) {
        let diff = (i - todayIndex + 7) % 7;
        if (diff === 0) diff = 7;
        baseDate = addDays(now, diff + 7); // skip to next week
        break;
      }
    }
  }

  // Plain weekdays
  if (!baseDate) {
    for (let i = 0; i < weekdays.length; i++) {
      const day = weekdays[i];
      if (text.includes(day)) {
        let diff = (i - todayIndex + 7) % 7;
        if (diff === 0) diff = 7; // interpret as upcoming, not today
        baseDate = addDays(now, diff);
        break;
      }
    }
  }

  // Numeric day of month (12, 12th, 23rd, etc.)
  if (!baseDate) {
    const dateMatch = text.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
    if (dateMatch) {
      let dayNum = parseInt(dateMatch[1], 10);
      let month = now.getMonth();
      let year = now.getFullYear();
      let candidate = new Date(year, month, dayNum);

      if (candidate < now) {
        month += 1;
        if (month > 11) {
          month = 0;
          year += 1;
        }
        candidate = new Date(year, month, dayNum);
      }
      baseDate = candidate;
    }
  }

  // Time of day: 3pm, 3 pm, 7:30, 1130, etc.
  let timeMatch =
    text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/) ||
    text.match(/\b(\d{3,4})\b/);

  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    let minute = 0;
    let ampm = null;

    if (timeMatch[2]) {
      minute = parseInt(timeMatch[2].replace(":", ""), 10);
    }

    if (timeMatch[3]) {
      ampm = timeMatch[3];
    }

    // If they say "evening" and no am/pm, assume pm, same for morning
    if (!ampm) {
      if (partOfDay === "evening") ampm = "pm";
      else if (partOfDay === "morning") ampm = "am";
    }

    // If they gave 3 or 4 digit time like "1530"
    if (!timeMatch[3] && timeMatch[0].length === 4 && !timeMatch[2]) {
      const str = timeMatch[0];
      hour = parseInt(str.slice(0, 2), 10);
      minute = parseInt(str.slice(2), 10);
    }

    timeString = formatTimeDisplay(hour, minute, ampm);
  }

  // If we have a base date AND a time
  if (baseDate && timeString) {
    return formatDateAU(baseDate) + " at " + timeString;
  }

  // If we have a base date and just part of day
  if (baseDate && partOfDay) {
    return formatDateAU(baseDate) + " " + partOfDay;
  }

  // If we only have a base date
  if (baseDate) {
    return formatDateAU(baseDate);
  }

  // If we only have time or part of day
  if (timeString && partOfDay) {
    return timeString + " (" + partOfDay + ")";
  }

  if (timeString) {
    return "at " + timeString;
  }

  if (partOfDay) {
    return partOfDay;
  }

  // Fallback: return cleaned text
  return text;
}

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Handyman AI Voice server is running.");
});

// ------------------------------------------------------------
// GET OR CREATE SESSION OBJECT
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
// FIRST GREETING
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);
    session.stage = "ask_name";

    console.log("📞 /voice endpoint hit from", from);

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
// MAIN LOOP – booking, repeat, cleaning, SMS
// ------------------------------------------------------------
app.post("/gather", async (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);

    const userSpeechRaw = req.body.SpeechResult || "";
    const cleaned = cleanSpeech(userSpeechRaw);
    const userSpeech = cleaned.toLowerCase();

    console.log("🗣 Raw speech:", userSpeechRaw);
    console.log("✨ Cleaned speech:", cleaned);

    const twiml = new twilio.twiml.VoiceResponse();

    // --------------------------------------------------------
    // REPEAT HANDLING
    // --------------------------------------------------------
    if (
      userSpeech.includes("repeat") ||
      userSpeech.includes("say again") ||
      userSpeech.includes("could you say that again") ||
      userSpeech.includes("can you say that again") ||
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
        speechTimeout: 2,
        timeout: 8
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
      case "ask_name": {
        let name = cleaned
          .replace(/my name is/i, "")
          .replace(/i am/i, "")
          .replace(/i'm/i, "")
          .replace(/this is/i, "")
          .replace(/it's/i, "")
          .replace(/its/i, "")
          .replace(/the name is/i, "")
          .trim();

        name = name.split(" ")[0];
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

        b.name = name;
        session.stage = "ask_job";

        reply =
          "Nice to meet you, " +
          name +
          ". What do you need a hand with today?";
        break;
      }

      case "ask_job":
        b.job = cleaned.trim();
        session.stage = "ask_suburb";
        reply = "Got it, " + b.job + ". Which suburb are you in?";
        break;

      case "ask_suburb": {
        const suburb = extractSuburb(cleaned);

        console.log("📍 Suburb extracted:", suburb);

        if (!suburb || suburb.length < 2) {
          reply =
            "Sorry, I didn't quite catch the suburb. What suburb are you in?";
          break;
        }

        b.suburb = suburb;
        session.stage = "ask_time";

        reply =
          "Thanks. When would you like us to come out? For example, tomorrow afternoon or next Tuesday morning.";
        break;
      }

      case "ask_time": {
        const timeValue = extractTime(cleaned);

        console.log("⏰ Extracted time:", timeValue);

        if (!timeValue || timeValue.length < 2) {
          reply = "Sorry, when would you like us to come out?";
          break;
        }

        b.time = timeValue;
        session.stage = "confirm";

        reply =
          "Beautiful. So I’ve got " +
          b.job +
          " in " +
          b.suburb +
          " at " +
          b.time +
          ". Is that right?";
        break;
      }

      case "confirm":
        console.log("🟦 Confirmation stage — user said:", cleaned);

        if (
          userSpeech.includes("yes") ||
          userSpeech.includes("yeah") ||
          userSpeech.includes("yep") ||
          userSpeech.includes("sure") ||
          userSpeech.includes("correct") ||
          userSpeech.includes("right") ||
          userSpeech.includes("that's right") ||
          userSpeech.includes("sounds good") ||
          userSpeech.includes("okay") ||
          userSpeech.includes("ok") ||
          userSpeech.includes("yup")
        ) {
          console.log("✅ Confirmation accepted — preparing SMS...");
          session.stage = "completed";

          reply =
            "Perfect, " +
            (b.name || "mate") +
            ". I’ll send you a text with the booking details and the team will be in touch shortly. Thanks for calling.";

          const customerBody =
            "Thanks for calling Barish’s Handyman Desk.\n" +
            "Booking details:\n" +
            "Name: " +
            b.name +
            "\n" +
            "Job: " +
            b.job +
            "\n" +
            "Suburb: " +
            b.suburb +
            "\n" +
            "Preferred time: " +
            b.time +
            "\n" +
            "We’ll be in touch shortly.";

          const ownerBody =
            "New handyman enquiry:\n" +
            "From: " +
            b.name +
            " (" +
            b.phone +
            ")\n" +
            "Job: " +
            b.job +
            "\n" +
            "Suburb: " +
            b.suburb +
            "\n" +
            "Preferred time: " +
            b.time +
            "\n";

          try {
            // CUSTOMER SMS
            console.log("📤 Attempting SMS to customer:", from);

            if (from !== "unknown") {
              client.messages
                .create({
                  from: "+61468067099",
                  to: from,
                  body: customerBody
                })
                .then((m) =>
                  console.log("✅ SMS sent to customer:", m.sid)
                )
                .catch((e) =>
                  console.error(
                    "❌ Error SMS to customer:",
                    e.message
                  )
                );
            }

            // OWNER SMS
            console.log("📤 Attempting SMS to owner: +61404983231");

            client.messages
              .create({
                from: "+61468067099",
                to: "+61404983231",
                body: ownerBody
              })
              .then((m) =>
                console.log("✅ SMS sent to owner:", m.sid)
              )
              .catch((e) =>
                console.error(
                  "❌ Error SMS to owner:",
                  e.message
                )
              );
          } catch (smsErr) {
            console.error("❌ SMS sending error:", smsErr);
          }
        } else if (userSpeech.includes("no")) {
          reply =
            "No worries, let’s try that again. What do you need help with?";
          session.stage = "ask_job";
        } else {
          reply =
            "Sorry, I just want to double check. Is that booking correct?";
        }
        break;

      case "completed":
        reply =
          "Thanks again for calling Barish’s handyman line. Is there anything else you need today?";
        break;

      default:
        reply =
          "Sorry, I didn’t quite get that. Could you say it again?";
    }

    // SPEAK reply
    session.lastReply = reply;
    twiml.say({ voice: "alice", language: "en-AU" }, reply);

    // END or CONTINUE
    if (session.stage === "completed") {
      twiml.say(
        { voice: "alice", language: "en-AU" },
        "Have a lovely day. Bye for now."
      );
      twiml.hangup();
    } else {
      const gather = twiml.gather({
        input: "speech",
        action: "/gather",
        method: "POST",
        language: "en-AU",
        speechTimeout: 2,
        timeout: 10
      });
      gather.say({ voice: "alice", language: "en-AU" }, "");
    }

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("❌ Error in /gather:", err);
    res.type("text/xml");
    res.send(
      "<Response><Say>Sorry, I'm having trouble right now.</Say></Response>"
    );
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
