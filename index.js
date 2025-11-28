// realtime-server.js
// ⚠️ Advanced Twilio <-> OpenAI Realtime bridge skeleton
// Keep your existing index.js booking bot separate until this is tested.

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

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// ------------------------------------------------------------
// HEALTH CHECK
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("Handyman Realtime Voice server is running.");
});

// ------------------------------------------------------------
// 1) TWILIO WEBHOOK: start Media Stream instead of Gather
// ------------------------------------------------------------
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Twilio will open a WebSocket to wss://your-domain/twilio-media
  const start = twiml.start();
  start.stream({
    url: `wss://${process.env.PUBLIC_HOST}/twilio-media`
  });

  // Keep call open for 5 minutes while audio streams
  twiml.pause({ length: 300 });

  res.type("text/xml");
  res.send(twiml.toString());
});

// ------------------------------------------------------------
// 2) HTTP + WebSocket server
// ------------------------------------------------------------
const server = http.createServer(app);

// WebSocket server that Twilio connects to for media stream
const twilioWss = new WebSocketServer({ noServer: true });

// Helper: set up OpenAI Realtime connection for this call
function connectOpenAIForCall(callContext) {
  return new Promise((resolve, reject) => {
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

      // Configure session: Aussie handyman receptionist
      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          voice: "alloy", // or another supported voice
          instructions: `
You are a warm, calm Aussie receptionist for Barish's handyman business.
Have a natural phone conversation with the caller.
Ask for:
- first name
- what they need done
- their suburb
- their preferred time (date & time or something like "tomorrow morning").

Confirm the details back in one short sentence before moving on.
Keep responses short (1–2 sentences).
Sound natural, leave slight pauses, and don't talk over the caller.
If they sound finished, politely wrap up the call.
          `,
          input_audio_transcription: {
            model: "whisper-1"
          },
          // Let the server detect when the caller stops talking
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            silence_duration_ms: 500,
            prefix_padding_ms: 300
          }
        }
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      resolve(openaiWs);
    });

    openaiWs.on("error", (err) => {
      console.error("❌ OpenAI WS error:", err.message);
      reject(err);
    });

    // You can also listen for text transcripts & responses here
    openaiWs.on("message", (msg) => {
      try {
        const event = JSON.parse(msg.toString());

        // Debug some important events
        if (event.type === "response.audio.delta") {
          // audio handled elsewhere
          return;
        }
        if (event.type === "response.text.delta") {
          console.log("📝 AI text:", event.delta);
        }
        if (event.type === "response.completed") {
          console.log("✅ Response completed");
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
// 3) Handle Twilio Media Stream <-> OpenAI Realtime bridge
// ------------------------------------------------------------
twilioWss.on("connection", async (twilioSocket) => {
  console.log("🔌 Twilio media stream connected");

  let streamSid = null;
  let openaiWs = null;

  try {
    openaiWs = await connectOpenAIForCall({});

    // When we receive events back from OpenAI (audio deltas), forward to Twilio
    openaiWs.on("message", (msg) => {
      if (!twilioSocket || twilioSocket.readyState !== WebSocket.OPEN) return;

      try {
        const event = JSON.parse(msg.toString());

        // Audio chunks from model
        if (event.type === "response.audio.delta" && event.delta) {
          // event.delta is base64 audio (PCM16 24kHz by default)
          // Twilio expects base64 G.711 μ-law 8kHz.
          // For a production system, you'd convert formats here.
          // For now, we just log — this part needs proper audio transcoding.

          // TODO: Implement PCM16 -> μ-law/8kHz conversion.
          // twilioSocket.send(JSON.stringify({
          //   event: "media",
          //   streamSid,
          //   media: { payload: ulawBase64 }
          // }));

          console.log("🎧 Got audio delta from OpenAI (length):", event.delta.length);
        }
      } catch (e) {
        console.error("Error handling OpenAI message:", e);
      }
    });

  } catch (err) {
    console.error("❌ Could not connect to OpenAI Realtime:", err.message);
    twilioSocket.close();
    return;
  }

  // Receive audio + control from Twilio
  twilioSocket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        console.log("📡 Twilio stream started:", streamSid);
      }

      if (data.event === "media") {
        // Twilio sends G.711 μ-law audio base64 in data.media.payload
        const ulawBase64 = data.media.payload;

        // For proper audio, you should convert μ-law 8kHz to PCM16 24kHz or 16kHz
        // and then send to OpenAI. The Realtime best-practice guide shows how. :contentReference[oaicite:3]{index=3}
        //
        // Here we forward it "as-is" as a starting point – you will likely
        // need to add real transcoding for production quality.

        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: ulawBase64
            // Optionally: audio_format: "g711_ulaw",
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
// 4) Upgrade HTTP -> WebSocket for /twilio-media
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
