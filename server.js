const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const twilio = require("twilio");
const multer = require("multer");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   🔌 HTTP + Socket.IO FIRST
   (so io is available in all routes)
========================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* =========================
   📁 Upload folders
========================= */
const uploadDir = path.join(__dirname, "uploads");
const photoDir  = path.join(uploadDir, "photos");
const audioDir  = path.join(uploadDir, "audio");

[uploadDir, photoDir, audioDir].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, photoDir),
  filename: (req, file, cb) => cb(null, `sos_photo_${Date.now()}.jpg`),
});

const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, audioDir),
  filename: (req, file, cb) => cb(null, `sos_audio_${Date.now()}.webm`),
});

const uploadPhoto = multer({ storage: photoStorage });
const uploadAudio = multer({ storage: audioStorage });

// Serve uploaded files publicly
app.use("/uploads", express.static(uploadDir));

/* =========================
   🔌 MongoDB Connection
========================= */
mongoose.connect("mongodb://127.0.0.1:27017/safeguard")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch((err) => console.log(err));

/* =========================
   📦 SCHEMAS
========================= */
const locationSchema = new mongoose.Schema({
  lat: Number,
  lng: Number,
  timestamp: { type: Date, default: Date.now },
});
const Location = mongoose.model("Location", locationSchema);

const alertSchema = new mongoose.Schema({
  contacts:       [String],
  location:       { lat: Number, lng: Number },
  trigger: {
    type: String,
    enum: [
      "manual", "shake", "voice", "low-battery",
      "volume-btn", "bluetooth", "scheduled",
      "timer-expired", "decoy",
    ],
    default: "manual",
  },
  status: {
    type: String,
    enum: ["sent", "queued", "failed"],
    default: "queued",
  },
  smsSentTo:      [String],
  smsFailed:      [String],
  whatsappSentTo: [String],
  whatsappFailed: [String],
  photoFile:      String,   // ← SOS photo filename
  audioFile:      String,   // ← SOS audio filename
  retryCount:     { type: Number, default: 0 },
  timestamp:      { type: Date, default: Date.now },
});
const Alert = mongoose.model("Alert", alertSchema);

const queueSchema = new mongoose.Schema({
  contacts:  [String],
  location:  { lat: Number, lng: Number },
  trigger:   String,
  timestamp: { type: Date, default: Date.now },
  retries:   { type: Number, default: 0 },
});
const QueuedAlert = mongoose.model("QueuedAlert", queueSchema);

const contactSchema = new mongoose.Schema({
  name:      String,
  number:    String,
  isPrimary: { type: Boolean, default: false },
  whatsapp:  { type: Boolean, default: true },
});
const Contact = mongoose.model("Contact", contactSchema);

const bluetoothSchema = new mongoose.Schema({
  deviceId:   String,
  location:   { lat: Number, lng: Number },
  peersFound: Number,
  timestamp:  { type: Date, default: Date.now },
});
const BluetoothBroadcast = mongoose.model("BluetoothBroadcast", bluetoothSchema);

const mediaSchema = new mongoose.Schema({
  type:      { type: String, enum: ["photo", "audio"] },
  filename:  String,
  url:       String,
  trigger:   String,
  location:  { lat: Number, lng: Number },
  timestamp: { type: Date, default: Date.now },
});
const MediaLog = mongoose.model("MediaLog", mediaSchema);

/* =========================
   📱 Twilio Setup
========================= */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const sendSMS = async (to, message) => {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+91${to}`,
    });
    console.log(`✅ SMS sent to ${to}`);
    return { success: true, number: to };
  } catch (err) {
    console.error(`❌ SMS failed to ${to}:`, err.message);
    return { success: false, number: to, error: err.message };
  }
};

const sendWhatsApp = async (to, message) => {
  try {
    await twilioClient.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886"}`,
      to: `whatsapp:+91${to}`,
    });
    console.log(`✅ WhatsApp sent to ${to}`);
    return { success: true, number: to };
  } catch (err) {
    console.error(`❌ WhatsApp failed to ${to}:`, err.message);
    return { success: false, number: to, error: err.message };
  }
};

const buildSOSMessage = (location, trigger, mediaUrl = null) => {
  const triggerLabels = {
    manual:          "SOS button pressed",
    shake:           "Phone shaken 3x",
    voice:           "Voice keyword detected",
    "low-battery":   "Low battery auto-alert",
    "volume-btn":    "Volume button trigger",
    bluetooth:       "Bluetooth SOS",
    "timer-expired": "Safe arrival timer expired — she did not check in",
    decoy:           "Triggered via decoy screen",
    scheduled:       "Scheduled check-in missed",
  };

  const mapLink = location
    ? `https://maps.google.com/?q=${location.lat},${location.lng}`
    : "Location unavailable";

  const mediaLine = mediaUrl
    ? `\n📸 Evidence: ${mediaUrl}`
    : "";

  return `🚨 EMERGENCY SOS — SafeGuard

Reason: ${triggerLabels[trigger] || trigger}
📍 Live Location: ${mapLink}
🕐 Time: ${new Date().toLocaleString("en-IN")}${mediaLine}

Please call her immediately or contact police at 112.
This is an automated emergency alert.`;
};

/* =========================
   🗺️ TRACKER PAGE
========================= */
app.get("/tracker", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>SafeGuard — Live Tracker</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0a0a0f; color:white; font-family:system-ui,sans-serif; }
    #topbar {
      position:fixed; top:0; left:0; right:0; z-index:100;
      background:#0f0f1a; border-bottom:1px solid #1a1a2e;
      padding:10px 16px; display:flex; align-items:center;
      justify-content:space-between;
    }
    .brand { font-size:14px; font-weight:500; color:#e85d75; }
    #status {
      font-size:11px; padding:4px 12px; border-radius:20px;
      background:#1a0a0e; border:1px solid #e85d75; color:#e85d75;
    }
    #status.live { background:#14532d; border-color:#4ade80; color:#4ade80; }
    #status.sos  { background:#450a0a; border-color:#f87171; color:#f87171; }
    #map { width:100vw; height:calc(100vh - 90px); border:none; margin-top:52px; }
    #bar {
      position:fixed; bottom:0; left:0; right:0;
      background:#0f0f1a; border-top:1px solid #1a1a2e;
      padding:8px 16px; font-size:10px; color:#555;
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    #sosBox {
      display:none; position:fixed; top:60px; left:50%;
      transform:translateX(-50%); background:#450a0a;
      border:1px solid #f87171; border-radius:12px;
      padding:12px 20px; text-align:center; z-index:200; min-width:240px;
    }
    .sos-title { color:#f87171; font-size:14px; font-weight:600; }
    .sos-sub   { color:#7a3040; font-size:11px; margin-top:3px; }
    #mediaBox {
      display:none; position:fixed; bottom:48px; right:16px;
      background:#0f0f1a; border:1px solid #1a1a2e; border-radius:12px;
      padding:10px; z-index:150; max-width:200px;
    }
    #mediaBox img { width:100%; border-radius:8px; }
    #mediaBox audio { width:100%; margin-top:6px; }
    #mediaTitle { font-size:10px; color:#e85d75; margin-bottom:6px; font-weight:600; }
  </style>
</head>
<body>
  <div id="topbar">
    <div class="brand">🛡️ SafeGuard Tracker</div>
    <div id="status">⏳ Waiting...</div>
  </div>
  <div id="sosBox">
    <div class="sos-title">🚨 SOS TRIGGERED</div>
    <div class="sos-sub" id="sosDetail"></div>
  </div>
  <div id="mediaBox">
    <div id="mediaTitle">SOS Evidence</div>
    <img id="mediaPhoto" src="" style="display:none" alt="SOS Photo" />
    <audio id="mediaAudio" controls style="display:none"></audio>
  </div>
  <iframe id="map" src="about:blank"></iframe>
  <div id="bar">No location yet — waiting for device...</div>
  <script>
    const socket = io();
    const hist = [];

    socket.on("locationUpdate", function(d) {
      document.getElementById("map").src =
        "https://maps.google.com/maps?q=" + d.lat + "," + d.lng + "&z=17&output=embed";
      var s = document.getElementById("status");
      s.className = "live";
      s.textContent = "📍 Live · " + d.lat.toFixed(5) + ", " + d.lng.toFixed(5);
      hist.unshift(d.lat.toFixed(3) + "," + d.lng.toFixed(3) + " @ " + new Date().toLocaleTimeString());
      document.getElementById("bar").textContent = "Path: " + hist.slice(0,5).join(" → ");
    });

    socket.on("sosAlert", function(d) {
      var b = document.getElementById("sosBox");
      b.style.display = "block";
      document.getElementById("sosDetail").textContent =
        d.trigger + " at " + new Date(d.time).toLocaleTimeString();
      document.getElementById("status").className = "sos";
      document.getElementById("status").textContent = "🚨 SOS ACTIVE";
      setTimeout(function(){ b.style.display = "none"; }, 15000);
    });

    socket.on("sosPhoto", function(d) {
      var box = document.getElementById("mediaBox");
      var img = document.getElementById("mediaPhoto");
      box.style.display = "block";
      img.style.display = "block";
      img.src = d.url;
    });

    socket.on("sosAudio", function(d) {
      var box = document.getElementById("mediaBox");
      var audio = document.getElementById("mediaAudio");
      box.style.display = "block";
      audio.style.display = "block";
      audio.src = d.url;
    });

    socket.on("bluetoothSOS", function(d) {
      alert("🔵 Bluetooth SOS — " + d.peersFound + " peers found nearby");
    });
  </script>
</body>
</html>`);
});

/* =========================
   📸 PHOTO UPLOAD
========================= */
app.post("/upload-photo", uploadPhoto.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo received" });

    const url = `${req.protocol}://${req.get("host")}/uploads/photos/${req.file.filename}`;
    console.log(`📸 SOS photo saved: ${req.file.filename}`);

    await new MediaLog({
      type: "photo", filename: req.file.filename, url,
      trigger: req.body.trigger || "manual",
      location: req.body.lat ? { lat: Number(req.body.lat), lng: Number(req.body.lng) } : null,
    }).save();

    // Notify tracker dashboard instantly
    io.emit("sosPhoto", { url, time: new Date() });

    res.json({ message: "Photo saved", url, filename: req.file.filename });
  } catch (err) {
    console.error("Photo upload error:", err);
    res.status(500).json({ error: "Photo upload failed" });
  }
});

/* =========================
   🎙️ AUDIO UPLOAD
========================= */
app.post("/upload-audio", uploadAudio.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio received" });

    const url = `${req.protocol}://${req.get("host")}/uploads/audio/${req.file.filename}`;
    console.log(`🎙️ SOS audio saved: ${req.file.filename}`);

    await new MediaLog({
      type: "audio", filename: req.file.filename, url,
      trigger: req.body.trigger || "manual",
      location: req.body.lat ? { lat: Number(req.body.lat), lng: Number(req.body.lng) } : null,
    }).save();

    // Notify tracker dashboard instantly
    io.emit("sosAudio", { url, time: new Date() });

    res.json({ message: "Audio saved", url, filename: req.file.filename });
  } catch (err) {
    console.error("Audio upload error:", err);
    res.status(500).json({ error: "Audio upload failed" });
  }
});

/* =========================
   📋 MEDIA LOG
========================= */
app.get("/media-log", async (req, res) => {
  const logs = await MediaLog.find().sort({ timestamp: -1 }).limit(20);
  res.json(logs);
});

/* =========================
   🚨 SOS ALERT — MAIN
========================= */
app.post("/send-alert", async (req, res) => {
  const { contacts, location, trigger = "manual" } = req.body;

  console.log(`\n🚨 SOS [${trigger}]`);
  console.log(`   Contacts : ${contacts}`);
  console.log(`   Location : ${JSON.stringify(location)}`);

  if (location) {
    await new Location({ lat: location.lat, lng: location.lng }).save();
    io.emit("locationUpdate", location);
  }

  io.emit("sosAlert", { contacts, location, trigger, time: new Date() });

  const message        = buildSOSMessage(location, trigger);
  const smsSentTo      = [], smsFailed      = [];
  const whatsappSentTo = [], whatsappFailed = [];

  for (const number of contacts) {
    const sms = await sendSMS(number, message);
    sms.success ? smsSentTo.push(number) : smsFailed.push(number);

    const wa = await sendWhatsApp(number, message);
    wa.success ? whatsappSentTo.push(number) : whatsappFailed.push(number);
  }

  const alert = await new Alert({
    contacts, location, trigger,
    status: smsFailed.length === contacts.length ? "failed" : "sent",
    smsSentTo, smsFailed, whatsappSentTo, whatsappFailed,
  }).save();

  console.log(`   SMS: ${smsSentTo.length}/${contacts.length} sent`);
  console.log(`   WA:  ${whatsappSentTo.length}/${contacts.length} sent`);

  res.json({
    message: "Alert processed",
    sms:      { sent: smsSentTo,      failed: smsFailed },
    whatsapp: { sent: whatsappSentTo, failed: whatsappFailed },
    alertId:  alert._id,
  });
});

/* =========================
   💬 OFFLINE QUEUE — Save
========================= */
app.post("/queue-alert", async (req, res) => {
  const { contacts, location, trigger } = req.body;
  const queued = await new QueuedAlert({ contacts, location, trigger }).save();
  console.log("📥 Alert queued:", queued._id);
  res.json({ message: "Alert queued", id: queued._id });
});

/* =========================
   🔁 OFFLINE QUEUE — Flush
========================= */
app.post("/flush-queue", async (req, res) => {
  const pending = await QueuedAlert.find();
  if (!pending.length) return res.json({ message: "No queued alerts" });

  const results = [];
  for (const item of pending) {
    const msg = buildSOSMessage(item.location, item.trigger);
    const ss=[], sf=[], ws=[], wf=[];

    for (const n of item.contacts) {
      const s = await sendSMS(n, msg);      s.success ? ss.push(n) : sf.push(n);
      const w = await sendWhatsApp(n, msg); w.success ? ws.push(n) : wf.push(n);
    }

    await new Alert({
      contacts: item.contacts, location: item.location, trigger: item.trigger,
      status: sf.length === item.contacts.length ? "failed" : "sent",
      smsSentTo: ss, smsFailed: sf, whatsappSentTo: ws, whatsappFailed: wf,
    }).save();

    await QueuedAlert.findByIdAndDelete(item._id);
    if (item.location) io.emit("locationUpdate", item.location);
    io.emit("sosAlert", { contacts: item.contacts, location: item.location, trigger: item.trigger });
    results.push({ id: item._id, smsSent: ss, waSent: ws });
  }

  console.log(`✅ Flushed ${results.length} queued alerts`);
  res.json({ message: `Flushed ${results.length} alerts`, results });
});

/* =========================
   🔁 RETRY SINGLE ALERT
========================= */
app.post("/retry-alert/:id", async (req, res) => {
  const alert = await Alert.findById(req.params.id);
  if (!alert) return res.status(404).json({ error: "Not found" });

  const msg = buildSOSMessage(alert.location, alert.trigger);
  const ns=[], nf=[], nws=[], nwf=[];

  for (const n of alert.smsFailed) {
    const s = await sendSMS(n, msg); s.success ? ns.push(n) : nf.push(n);
  }
  for (const n of (alert.whatsappFailed || [])) {
    const w = await sendWhatsApp(n, msg); w.success ? nws.push(n) : nwf.push(n);
  }

  alert.smsSentTo.push(...ns);
  alert.smsFailed      = nf;
  alert.whatsappSentTo = [...(alert.whatsappSentTo || []), ...nws];
  alert.whatsappFailed = nwf;
  alert.retryCount    += 1;
  alert.status         = nf.length === 0 ? "sent" : "failed";
  await alert.save();

  res.json({ message: "Retry complete", sms:{sent:ns,failed:nf}, whatsapp:{sent:nws,failed:nwf} });
});

/* =========================
   🔵 BLUETOOTH BROADCAST
========================= */
app.post("/bluetooth-sos", async (req, res) => {
  const { deviceId, location, peersFound = 0 } = req.body;
  const log = await new BluetoothBroadcast({ deviceId, location, peersFound }).save();
  io.emit("bluetoothSOS", { deviceId, location, peersFound, time: new Date() });
  console.log(`🔵 Bluetooth SOS from ${deviceId} — Peers: ${peersFound}`);
  res.json({ message: "Bluetooth SOS logged", id: log._id });
});

/* =========================
   📡 LIVE LOCATION
========================= */
app.post("/live-location", async (req, res) => {
  try {
    const { lat, lng } = req.body;
    await new Location({ lat, lng }).save();
    io.emit("locationUpdate", { lat, lng });
    res.json({ message: "Saved" });
  } catch (err) {
    res.status(500).json({ error: "Error saving location" });
  }
});

/* =========================
   📍 LATEST LOCATION
========================= */
app.get("/latest-location", async (req, res) => {
  const loc = await Location.findOne().sort({ timestamp: -1 });
  res.json(loc);
});

/* =========================
   📜 LOCATION HISTORY
========================= */
app.get("/location-history", async (req, res) => {
  const h = await Location.find().sort({ timestamp: -1 }).limit(50);
  res.json(h);
});

/* =========================
   📋 ALERT HISTORY
========================= */
app.get("/alert-history", async (req, res) => {
  const a = await Alert.find().sort({ timestamp: -1 }).limit(50);
  res.json(a);
});

/* =========================
   📋 QUEUE STATUS
========================= */
app.get("/queue-status", async (req, res) => {
  const count = await QueuedAlert.countDocuments();
  const items = await QueuedAlert.find().sort({ timestamp: -1 });
  res.json({ pending: count, items });
});

/* =========================
   👥 CONTACTS CRUD
========================= */
app.get("/contacts", async (req, res) => {
  res.json(await Contact.find());
});

app.post("/contacts", async (req, res) => {
  const { name, number, isPrimary, whatsapp } = req.body;
  const c = await new Contact({ name, number, isPrimary, whatsapp }).save();
  res.json(c);
});

app.delete("/contacts/:id", async (req, res) => {
  await Contact.findByIdAndDelete(req.params.id);
  res.json({ message: "Deleted" });
});

/* =========================
   🧪 TEST ROUTE
========================= */
app.get("/test", async (req, res) => {
  const loc = new Location({ lat: 18.5204, lng: 73.8567 });
  await loc.save();
  io.emit("locationUpdate", { lat: 18.5204, lng: 73.8567 });
  res.send("✅ Test OK — location saved & emitted");
});

/* =========================
   🔌 SOCKET.IO EVENTS
========================= */
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);

  socket.on("deviceOnline", async () => {
    console.log("📶 Device back online — checking queue");
    const pending = await QueuedAlert.find();
    if (pending.length) socket.emit("flushingQueue", { count: pending.length });
  });

  socket.on("bluetoothPeer", (data) => {
    console.log("🔵 BT Peer:", data);
    io.emit("bluetoothPeerAlert", data);
  });

  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);
  });
});

/* =========================
   🚀 START
========================= */
server.listen(5000, () => {
  console.log("\n🚀 SafeGuard server running");
  console.log("   App     → http://localhost:3000");
  console.log("   API     → http://localhost:5000");
  console.log("   Tracker → http://localhost:5000/tracker");
  console.log("   Test    → http://localhost:5000/test\n");
});