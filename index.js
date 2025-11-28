// realtime-server.js
// Advanced Twilio <-> OpenAI Realtime bridge with submit_booking tool

import express from "express";
import http from "http";
import twilio from "twilio";
import WebSocket, { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;

console.log("TWILIO SID:", process.env.TWILIO_SID ? "OK" : "MISSING");
console.log("TWILIO AUTH:", process.env.TWILIO_AUTH ? "OK" : "MISSING");
console.log("OPENAI KEY:", process.env.OPENAI_API_KEY ? "OK" : "MISSING");
console.log("PUBLIC_HOST:", process.env.PUBLIC_HOST || "MISSING");

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Handyman Realtime Voice server is running.");
});

// ------------------------------------------------------------
// TWILIO WEBHOOK: start Media Stream instead of Gather
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const start = twiml.start();
  start.stream({
    url: `wss://${process.env.PUBLIC_HOST}/twilio-media`
  });

  // Keep call open for 5 minutes
  twiml.pause({ length: 300 });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// HTTP + WebSocket server
// ------------------------------------------------------------
const server = http.createServer(app);
const twilioWss = new WebSocketServer({ noServer: true });

// ------------------------------------------------------------
// Tool: submit_booking
// ------------------------------------------------------------
async function submitBooking({ name, job, suburb, time, phone }) {
  try {
    const safeName = name || "Customer";
    const safeJob = job || "Job not specified";
    const safeSuburb = suburb || "Suburb not specified";
    const safeTime = time || "Time not specified";
    const safePhone = phone || "Unknown";

    console.log("🧾 submit_booking called with:", {
      name: safeName,
      job: safeJob,
      suburb: safeSuburb,
      time: safeTime,
      phone: safePhone
    });

    const customerBody =
      "Thanks for calling Barish’s Handyman Desk.\n" +
      "Booking details:\n" +
      `Name: ${safeName}\n` +
      `Job: ${safeJob}\n` +
      `Suburb: ${safeSuburb}\n` +
      `Preferred time: ${safeTime}\n` +
      "We’ll be in touch shortly.";

    const ownerBody =
      "New handyman enquiry (Realtime):\n" +
      `From: ${safeName} (${safePhone})\n` +
      `Job: ${safeJob}\n` +
      `Suburb: ${safeSuburb}\n` +
      `Preferred time: ${safeTime}\n`;

    // SMS to customer (if we have a valid-looking phone)
    if (phone && phone.startsWith("+")) {
      console.log("📤 Attempting SMS to customer:", phone);
      await client.messages.create({
        from: "+61468067099",
        to: phone,
        body: customerBody
      });
      console.log("✅ SMS sent to customer");
    } else {
      console.log("⚠️ No valid customer phone, skipping customer SMS");
    }

    // SMS to you
    console.log("📤 Attempting SMS to owner: +61404983231");
    await client.messages.create({
      from: "+61468067099",
      to: "+61404983231",
      body: ownerBody
    });
    console.log("✅ SMS sent to owner");
  } catch (err) {
    console.error("❌ Error in submitBooking:", err.message);
  }
}

// ------------------------------------------------------------
// OpenAI Realtime – connect per call and define tool
// ------------------------------------------------------------
function connectOpenAIForCall(callContext) {
  return new Promise((resolve, reject) => {
    // Buffer for tool-call arguments
    const toolCallBuffers = {}; // { tool_call_id: "partial json string" }

    const openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    openaiWs.on("open", () => {
      console.log("✅ Connected to OpenAI Realtime API");

      // Session config + tool definition
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy",
          instructions: `
You are a warm, calm Aussie receptionist for Barish's handyman business.
You are talking to callers over the phone.
Your goals:
1) Have a natural conversation.
2) Collect: caller's first name, job description, suburb, preferred date/time, and phone number.
3) When you are confident, call the function "submit_booking" exactly once with:
   { "name": ..., "job": ..., "suburb": ..., "time": ..., "phone": ... }.
4) The phone field should be the caller's phone number you infer from context (server will also pass it).
5) Speak in short, friendly sentences. Don't ramble. Confirm the booking details briefly before calling submit_booking.
6) After calling submit_booking, politely wrap up the call.
          `,
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 500,
            prefix_padding_ms: 300
          },
          input_audio_transcription: {
            model: "whisper-1"
          },
          tools: [
            {
              type: "function",
              name: "submit_booking",
              description:
                "Submit a handyman booking once you have the caller's details.",
              parameters: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "Caller first name"
                  },
                  job: {
                    type: "string",
                    description: "Job description (e.g. paint a 9m2 room)"
                  },
                  suburb: {
                    type: "string",
                    description: "Suburb of the job (e.g. Sunbury)"
                  },
                  time: {
                    type: "string",
                    description:
                      "Requested time/date, in natural language (e.g. 'Tomorrow 3pm', 'Next Tuesday morning')"
                  },
                  phone: {
                    type: "string",
                    description:
                      "Caller phone number in E.164 format (e.g. +61412...)"
                  }
                },
                required: ["name", "job", "suburb", "time", "phone"]
              }
            }
          ]
        }
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      resolve({ openaiWs, toolCallBuffers });
    });

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WS error:", err.message);
      reject(err);
    });

    openaiWs.on("message", async (msg) => {
      try {
        const event = JSON.parse(msg.toString());

        // Debug transcripts
        if (event.type === "response.text.delta" && event.delta) {
          console.log("📝 AI text delta:", event.delta);
        }

        // Tool call arguments streaming (pattern may evolve; log everything)
        if (event.type === "response.function_call_arguments.delta") {
          const { id, delta, name } = event;
          if (!toolCallBuffers[id]) toolCallBuffers[id] = "";
          toolCallBuffers[id] += delta;
          console.log("🧩 Tool args delta for", name, "id:", id, "delta:", delta);
        }

        if (event.type === "response.function_call_arguments.done") {
          const { id, name } = event;
          const jsonStr = toolCallBuffers[id] || "";
          console.log("🧩 Tool args done for", name, "id:", id, "raw:", jsonStr);

          if (name === "submit_booking") {
            try {
              const args = JSON.parse(jsonStr);

              // If phone missing, try to inject caller number from callContext
              if (!args.phone && callContext && callContext.from) {
                args.phone = callContext.from;
              }

              await submitBooking(args);
            } catch (err) {
              console.error("❌ Failed to parse submit_booking args:", err.message);
            }
          }

          delete toolCallBuffers[id];
        }

        if (event.type === "response.completed") {
          console.log("✅ AI response completed");
        }

        if (event.type === "input_audio_buffer.speech_started") {
          console.log("🎙️ Caller started speaking");
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          console.log("🤫 Caller stopped speaking");
        }
      } catch (e) {
        console.error("Error parsing OpenAI message:", e);
      }
    });
  });
}

// ------------------------------------------------------------
// Twilio Media Stream <-> OpenAI Realtime bridge
// ------------------------------------------------------------
twilioWss.on("connection", async (twilioSocket, req) => {
  console.log("🔌 Twilio media stream connected");

  let streamSid = null;

  // Twilio doesn't pass caller in WS URL by default; we can’t see + phone here
  // but we CAN pass the caller number using query string or from /voice if needed.
  const callContext = {
    from: null // you could pass caller here if you modify /voice to add it
  };

  let openaiWsObj;
  try {
    openaiWsObj = await connectOpenAIForCall(callContext);
  } catch (err) {
    console.error("❌ Could not connect to OpenAI Realtime:", err.message);
    twilioSocket.close();
    return;
  }

  const { openaiWs, toolCallBuffers } = openaiWsObj;

  // Pipe audio from OpenAI -> Twilio (NOTE: transcoding still needed for real audio)
  openaiWs.on("message", (msg) => {
    if (!twilioSocket || twilioSocket.readyState !== WebSocket.OPEN) return;

    try {
      const event = JSON.parse(msg.toString());

      if (event.type === "response.audio.delta" && event.delta) {
        // event.delta is base64 PCM16 (24kHz).
        // Twilio expects base64 μ-law 8kHz.
        // For a production system, convert formats here.
        // For now, we just log it.
        console.log(
          "🎧 Got audio delta from OpenAI (base64 length):",
          event.delta.length
        );

        // TODO: PCM16 -> μ-law 8kHz conversion, then:
        // twilioSocket.send(JSON.stringify({
        //   event: "media",
        //   streamSid,
        //   media: { payload: ulawBase64 }
        // }));
      }
    } catch (e) {
      console.error("Error handling OpenAI audio message:", e);
    }
  });

  // Twilio -> OpenAI
  twilioSocket.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("📡 Twilio stream started:", streamSid);

        // If you had caller number here via start.customParameters,
        // you could set callContext.from = data.start.customParameters.from;
      }

      if (data.event === "media") {
        const ulawBase64 = data.media.payload;

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: "input_audio_buffer.append",
            // This is still μ-law base64; you may want to specify format if supported:
            // audio_format: "g711_ulaw",
            audio: ulawBase64
          };
          openaiWs.send(JSON.stringify(audioAppend));
        }
      }

      if (data.event === "stop") {
        console.log("🛑 Twilio stream stopped");
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        twilioSocket.close();
      }
    } catch (e) {
      console.error("Error parsing Twilio WS message:", e);
    }
  });

  twilioSocket.on("close", () => {
    console.log("❌ Twilio socket closed");
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
});

// ------------------------------------------------------------
// UPGRADE HTTP -> WebSocket for /twilio-media
// ------------------------------------------------------------
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-media") {
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ------------------------------------------------------------
// START SERVER
// ------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Realtime server listening on port ${PORT}`);
  console.log(`   PUBLIC_HOST should be set to your Railway / domain host (no https://)`);
});
