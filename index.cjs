/**
 * EarthContours B2 — WebSocket + OSC Server
 * ============================================
 *
 * This is the real-time communication bridge for the B2 Black Box exhibit.
 * It does TWO things:
 *
 * 1. RECEIVES OSC messages (from motion capture, MediaPipe, TouchOSC)
 *    on UDP port 57121, and FORWARDS them to all connected browser
 *    windows via Socket.IO WebSocket.
 *
 * 2. RELAYS "location:update" messages between browser windows,
 *    so when someone selects a location on the Map screen,
 *    the Wrap screen updates immediately.
 *
 * HOW TO RUN:
 *   Terminal 1:  node index.js          (starts this server on port 3000)
 *   Terminal 2:  npm run dev            (starts Vite dev server on port 5173)
 *
 * The Vite dev server proxies /socket.io requests to this server,
 * so the browser connects through Vite → here.
 *
 * OSC MESSAGES THIS SERVER EXPECTS:
 *   /trk_1_xy_loc  [y, x, f]   — Motion capture tracker 1 position (wrap screen)
 *   /trk_2_xy_loc  [y, x, f]   — Motion capture tracker 2 position (wrap screen)
 *   /hand_1_pos    [x, y]       — MediaPipe hand 1 position (map screen)
 *   /hand_2_pos    [x, y]       — MediaPipe hand 2 position (map screen)
 *   /hand_1_state  [state]      — Hand 1: 0=open, 1=fist, 2=pointing (map screen)
 *   /hand_2_state  [state]      — Hand 2: 0=open, 1=fist, 2=pointing (map screen)
 *
 * All OSC messages are forwarded as-is — the browser screens decide
 * which ones they care about.
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const osc = require("osc");

// ─── Setup Express + WebSocket ───────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Allow connections from Vite dev server (different port)
  cors: {
    origin: "*",
  },
});

// In production, serve the built Vite output from /dist
app.use(express.static("dist"));

// ─── OSC Setup ───────────────────────────────────────────────────────────────
// Listens for OSC messages on UDP port 57121.
// Any software that sends OSC (TouchOSC, MediaPipe bridge, etc.)
// should target this machine's IP on port 57121.

const udpPort = new osc.UDPPort({
  localAddress: "0.0.0.0",  // Listen on all network interfaces
  localPort: 57121,          // Standard OSC port for this exhibit
});

udpPort.on("ready", () => {
  console.log("✓ OSC server listening on UDP port", udpPort.options.localPort);
  console.log("  Send OSC messages to this machine on port 57121");
});

// When an OSC message arrives, forward it to ALL connected browser windows
udpPort.on("message", (oscMsg) => {
  // Log it so you can see what's coming in during testing
  //console.log("OSC HELLO received:", oscMsg.address, oscMsg.args.map(a => a.value ?? a));

  // Forward the raw OSC message to every connected browser
  // Each screen (wrap, map, settings) will filter for the addresses it cares about
  io.emit("osc", {
    address: oscMsg.address,
    args: oscMsg.args.map(a => a.value ?? a),  // Extract raw values from typed OSC args
  });
});

udpPort.on("error", (err) => {
  console.error("OSC Error:", err);
});

udpPort.open();

// ─── OSC OUT — Send /transition messages to Max/MSP ──────────────────────────
// This block exists ONLY to send OSC OUT to a Max/MSP machine on the LAN that
// is running [udpreceive]. The browser cannot speak UDP directly, so the
// browser emits a Socket.IO "transition" event to this Node server, and this
// server relays it as an OSC UDP packet to Max. Configure the Max machine's
// LAN IP and udpreceive port via env vars when launching the server:
//   OSC_OUT_HOST=192.168.1.42 OSC_OUT_PORT=7400 node index.cjs
const udpOut = new osc.UDPPort({
  remoteAddress: process.env.OSC_OUT_HOST || "192.168.10.41",
  remotePort: parseInt(process.env.OSC_OUT_PORT || "55557", 10),
});
udpOut.open();
console.log(`✓ OSC OUT → ${process.env.OSC_OUT_HOST || "192.168.10.41"}:${process.env.OSC_OUT_PORT || "55557"} (Max/MSP)`);

// ─── Socket.IO — Browser Connections ─────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("✓ Browser window connected:", socket.id);

  // LOCATION SYNC: When the map screen selects a location,
  // broadcast it to all OTHER windows (especially the wrap screen)
  socket.on("location:update", (data) => {
    console.log("Location update from map:", data.lat?.toFixed(4), data.lng?.toFixed(4));
    // Broadcast to everyone EXCEPT the sender (the map already has this location)
    socket.broadcast.emit("location:update", data);
  });

  // SETTINGS SYNC: When settings change, broadcast to all other windows
  socket.on("settings:update", (data) => {
    console.log("Settings update:", Object.keys(data).join(", "));
    socket.broadcast.emit("settings:update", data);
  });

  // OSC OUT: forward browser transition events to Max as /transition <0|1>.
  // The B2 wrap screen emits "transition" with 1 when a wrap-screen change
  // begins and 0 when the new skyline has finished loading. We pass that
  // value through to Max so the audio system can sync with the visuals.
  socket.on("transition", (value) => {
    const v = value ? 1 : 0;
    console.log(`→ OSC OUT /transition ${v}  →  ${udpOut.options.remoteAddress}:${udpOut.options.remotePort}`);
    udpOut.send({ address: "/transition", args: [{ type: "i", value: v }] });
  });

  socket.on("disconnect", () => {
    console.log("Browser window disconnected:", socket.id);
  });
});

// ─── Start the Web Server ────────────────────────────────────────────────────

const PORT = 3000;
server.listen(PORT, () => {
  console.log("");
  console.log("═══════════════════════════════════════════════════");
  console.log("  EarthContours B2 — WebSocket + OSC Server");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Web server:  http://localhost:${PORT}`);
  console.log(`  OSC input:   UDP port 57121`);
  console.log(`  WebSocket:   Socket.IO on port ${PORT}`);
  console.log("");
  console.log("  Now start Vite in another terminal: npm run dev");
  console.log("═══════════════════════════════════════════════════");
  console.log("");
});
