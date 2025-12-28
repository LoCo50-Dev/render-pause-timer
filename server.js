const express = require("express");
const fs = require("fs");
const app = express();
app.use(express.json());
app.use(express.static("public"));

const STATE_FILE = "./state.json";

function saveState(data){
  fs.writeFileSync(STATE_FILE, JSON.stringify(data));
}

function loadState(){
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE));
}

app.get("/state", (req, res) => {
  res.json(loadState());
});

app.post("/start", (req, res) => {
  const mins = req.body.minutes;
  const totalMs = mins * 60000;
  const endTime = Date.now() + totalMs;

  saveState({ totalMs, endTime });
  res.json({ ok:true });
});

app.listen(process.env.PORT || 3000);

