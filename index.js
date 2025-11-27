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
console.log("OPENAI KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");

// Twilio + OpenAI clients
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory sessions (per caller)
const sessions = {}; // { "+6146...": { stage, booking, lastReply } }

// Health check
app.get("/", (req, res) => {
  res.send("Handyman AI Voice server is running.");
});

// Helper: get or create session
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

// FIRST GREETING + first question
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

// MAIN LOOP – booking + repeat + SMS
app.post("/gather", async (req, res) => {
  try {
    const from = req.body.From || "unknown";
    const session = getSession(from);

    const userSpeechRaw = req.body.SpeechResult || "";
    const userSpeech = userSpeechRaw.toLowerCase();
    console.log("🗣 User said:", userSpeechRaw);

    const twiml = new twilio.twiml.VoiceResponse();

    // ----------------------------------------
    // 1) REPEAT HANDLING
    // ----------------------------------------
    if (
      userSpeech.includes("repeat") ||
      userSpeech.includes("say again") ||
      userSpeech.includes("could you say that again") ||
      userSpeech.includes("can you say that again") ||
      userSpeech.includes("pardon") ||
      userSpeech.includes("didn't catch") ||
      userSpeech.includes("didnt catch")
    ) {
      const toRepeat =
        session.lastReply || "Let me say that again more clearly.";
      const repeatLine = "Sure, no worries. " + toRepeat;

      twiml.say(
        { voice: "alice", language: "en-AU" },
        repeatLine
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

    // ----------------------------------------
    // 2) BOOKING FLOW (STATE MACHINE)
    // ----------------------------------------
    let reply = "";
    const b = session.booking;

    switch (session.stage) {
     case "ask_name":
    {
      // Clean name input
      let name = userSpeechRaw
        .replace(/my name is/i, "")
        .replace(/i am/i, "")
        .replace(/i'm/i, "")
        .replace(/this is/i, "")
        .replace(/it's/i, "")
        .replace(/its/i, "")
        .replace(/the name is/i, "")
        .trim();

      // Take only first word as first name
      name = name.split(" ")[0];

      // Capitalise properly
      name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

      b.name = name;
      session.stage = "ask_job";

      reply = "Nice to meet you, " + name + ". What do you need a hand with today?";
    }
    break;


      case "ask_job":
        b.job = userSpeechRaw.trim();
        session.stage = "ask_suburb";
        reply =
          "Got it, " +
          b.job +
          ". Which suburb are you in?";
        break;

      case "ask_suburb":
        b.suburb = userSpeechRaw.trim();
        session.stage = "ask_time";
        reply =
          "Thanks. When would you like us to come out? For example, tomorrow afternoon or next Tuesday morning.";
        break;

      case "ask_time":
        b.time = userSpeechRaw.trim();
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

      case "confirm":
        if (
          userSpeech.includes("yes") ||
          userSpeech.includes("correct") ||
          userSpeech.includes("that's right") ||
          userSpeech.includes("thats right") ||
          userSpeech.includes("right")
        ) {
          session.stage = "completed";

          reply =
            "Perfect, " +
            (b.name || "mate") +
            ". I’ll send you a text with the booking details and the team will be in touch shortly. Thanks for calling.";

          // Send SMS summaries (fire and forget)
          const customerBody =
            "Thanks for calling Barish’s Handyman Desk.\n" +
            "Booking details:\n" +
            "Name: " + (b.name || "") + "\n" +
            "Job: " + (b.job || "") + "\n" +
            "Suburb: " + (b.suburb || "") + "\n" +
            "Preferred time: " + (b.time || "") + "\n" +
            "We’ll be in touch shortly.";

          const ownerBody =
            "New handyman enquiry:\n" +
            "From: " + (b.name || "Unknown") + " (" + b.phone + ")\n" +
            "Job: " + (b.job || "") + "\n" +
            "Suburb: " + (b.suburb || "") + "\n" +
            "Preferred time: " + (b.time || "") + "\n";

          try {
            // SMS to customer
            if (from !== "unknown") {
              client.messages
                .create({
                  from: "+61468067099", // your Twilio number
                  to: from,
                  body: customerBody
                })
                .then(m => console.log("📩 Sent SMS to customer:", m.sid))
                .catch(e => console.error("❌ Error SMS to customer:", e));
            }

            // SMS to you
            client.messages
              .create({
                from: "+61468067099",
                to: "+61404983231", // your private mobile
                body: ownerBody
              })
              .then(m => console.log("📩 Sent SMS to owner:", m.sid))
              .catch(e => console.error("❌ Error SMS to owner:", e));
          } catch (smsErr) {
            console.error("❌ SMS sending error:", smsErr);
          }
        } else if (userSpeech.includes("no")) {
          // If they say no, restart from job description
          session.stage = "ask_job";
          reply =
            "No worries, let’s try that again. What do you need help with?";
        } else {
          // unclear answer at confirm stage
          reply =
            "Sorry, I just want to double check. Is that booking correct?";
        }
        break;

      case "completed":
        // After completion, be polite and let them go / answer quick questions
        reply =
          "Thanks again for calling Barish’s handyman line. Is there anything else you need today?";
        break;

      default:
        // fallback – light OpenAI answer if something weird happens
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are a warm, calm Aussie receptionist for a handyman service. Speak slowly, clearly, and conversationally in 1–2 short sentences."
            },
            { role: "user", content: userSpeechRaw }
          ]
        });
        reply = completion.choices[0].message.content.trim();
        break;
    }

    // Speak reply
    session.lastReply = reply;
    twiml.say({ voice: "alice", language: "en-AU" }, reply);

    // Decide whether to continue or end
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

      // small prompt to keep the line open, but not pushy
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

// START SERVER
app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
