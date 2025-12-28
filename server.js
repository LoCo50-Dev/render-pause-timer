const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, "data", "state.json");

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Lade Zustand oder init
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { running: false, endTime: 0, remainingMs: 0, paused: false };
  }
  const raw = fs.readFileSync(STATE_FILE);
  return JSON.parse(raw);
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/controller", (req,res)=>{
  res.sendFile(path.join(__dirname, "public", "controller.html"));
});

// API
app.get("/api/status", (req,res)=>{
  const state = loadState();
  res.json(state);
});

app.post("/api/start", (req,res)=>{
  const mins = Number(req.body.minutes) || 5;
  const endTime = Date.now() + mins*60000;
  const state = { running:true, endTime, paused:false, remainingMs:0 };
  saveState(state);
  res.json(state);
});

app.post("/api/pause", (req,res)=>{
  const state = loadState();
  if(!state.running || state.paused) return res.json(state);

  const remainingMs = state.endTime - Date.now();
  state.paused = true;
  state.remainingMs = remainingMs;
  state.endTime = 0;
  saveState(state);
  res.json(state);
});

app.post("/api/resume", (req,res)=>{
  const state = loadState();
  if(!state.paused) return res.json(state);

  state.endTime = Date.now() + state.remainingMs;
  state.paused = false;
  state.remainingMs = 0;
  saveState(state);
  res.json(state);
});

app.post("/api/reset", (req,res)=>{
  const state = loadState();
  state.running = false;
  state.paused = false;
  state.endTime = 0;
  state.remainingMs = 0;
  saveState(state);
  res.json(state);
});

app.listen(PORT, ()=>{
  console.log(`Server läuft auf Port ${PORT}`);
});
