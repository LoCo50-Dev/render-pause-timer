const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const stateFile = path.join(__dirname, "state.json");

function readState(){ return JSON.parse(fs.readFileSync(stateFile)); }
function writeState(s){ fs.writeFileSync(stateFile, JSON.stringify(s)); }

app.get("/api/status", (req,res)=>{
  res.json(readState());
});

app.post("/api/start", (req,res)=>{
  const mins = req.body.minutes || 20;
  const state = {
    running: true,
    paused: false,
    endTime: Date.now() + mins*60000,
    remainingMs: mins*60000,
    totalMs: mins*60000
  };
  writeState(state);
  res.json(state);
});

app.post("/api/pause",(req,res)=>{
  const state = readState();
  if(state.running && !state.paused){
    state.paused = true;
    state.remainingMs = state.endTime - Date.now();
    writeState(state);
  }
  res.json(state);
});

app.post("/api/resume",(req,res)=>{
  const state = readState();
  if(state.running && state.paused){
    state.paused = false;
    state.endTime = Date.now() + state.remainingMs;
    writeState(state);
  }
  res.json(state);
});

app.post("/api/reset",(req,res)=>{
  const state = readState();
  state.running = false;
  state.paused = false;
  state.remainingMs = 0;
  state.totalMs = 0;
  state.endTime = 0;
  writeState(state);
  res.json(state);
});

app.listen(3000,()=>console.log("Server running on port 3000"));
