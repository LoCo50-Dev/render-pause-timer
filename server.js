const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// In-Memory State (kein state.json mehr!)
let timerState = {
  duration: 0,
  remaining: 0,
  endTime: null,
  isPaused: false,
  isRunning: false,
  wasSkipped: false
};

// GET State
app.get('/api/state', (req, res) => {
  res.json(timerState);
});

// POST Update State
app.post('/api/state', (req, res) => {
  timerState = { ...timerState, ...req.body };
  res.json(timerState);
});

// Reset State
app.post('/api/reset', (req, res) => {
  timerState = {
    duration: 0,
    remaining: 0,
    endTime: null,
    isPaused: false,
    isRunning: false,
    wasSkipped: false
  };
  res.json(timerState);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
