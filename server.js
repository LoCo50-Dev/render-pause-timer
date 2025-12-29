const express = require('express');
const fs = require('fs');
const path = require('path');
const speakeasy = require('speakeasy');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// TOTP Configuration - NUTZT ENVIRONMENT VARIABLE!
const TOTP_SECRET = process.env.TOTP_SECRET;

// Spotify API Configuration - NUTZT ENVIRONMENT VARIABLES!
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = 'https://lc5-streamdesk.onrender.com/callback';

// Session Store (einfache In-Memory Lösung)
const activeSessions = new Set();

// In-Memory State
let timerState = {
  duration: 0,
  remaining: 0,
  endTime: null,
  isPaused: false,
  isRunning: false,
  wasSkipped: false,
  language: 'de',
  autoExtendTime: null // Zeitpunkt für Auto-Verlängerung
};

let spotifyState = {
  accessToken: null,
  refreshToken: null,
  volume: 50,
  isPlaying: false,
  currentTrack: null
};

let popupState = {
  isActive: false,
  selectedVideos: [],
  currentVideoIndex: 0,
  currentVideo: null,
  lastPlayedTime: null
};

// Video rotation interval (10 minutes)
const VIDEO_INTERVAL = 10 * 60 * 1000;

// ===== AUTHENTICATION =====

// TEST: Secret prüfen (LÖSCHE DAS SPÄTER!)
app.get('/api/test-secret', (req, res) => {
  res.json({
    secretExists: !!TOTP_SECRET,
    secretLength: TOTP_SECRET ? TOTP_SECRET.length : 0,
    firstChars: TOTP_SECRET ? TOTP_SECRET.substring(0, 5) : 'N/A'
  });
});

// Verify TOTP Code
app.post('/api/auth/verify', (req, res) => {
  const { code, sessionId } = req.body;
  
  console.log('=== AUTH ATTEMPT ===');
  console.log('Received code:', code);
  console.log('Code type:', typeof code);
  console.log('TOTP_SECRET exists:', !!TOTP_SECRET);
  console.log('TOTP_SECRET length:', TOTP_SECRET ? TOTP_SECRET.length : 0);
  
  if (!TOTP_SECRET) {
    console.log('ERROR: TOTP_SECRET not set');
    return res.json({ success: false, error: 'Server not configured' });
  }
  
  // Generiere den erwarteten Code
  const expectedToken = speakeasy.totp({
    secret: TOTP_SECRET,
    encoding: 'base32'
  });
  
  console.log('Expected token:', expectedToken);
  console.log('Codes match (strict):', code === expectedToken);
  console.log('Codes match (string):', String(code) === String(expectedToken));
  
  const verified = speakeasy.totp.verify({
    secret: TOTP_SECRET,
    encoding: 'base32',
    token: code,
    window: 6 // Mehr Toleranz: 3 Minuten
  });
  
  console.log('Verification result:', verified);
  console.log('===================');
  
  if (verified) {
    activeSessions.add(sessionId);
    res.json({ success: true });
  } else {
    res.json({ success: false, error: 'Invalid code' });
  }
});

// Check if session is valid
app.post('/api/auth/check', (req, res) => {
  const { sessionId } = req.body;
  const isValid = activeSessions.has(sessionId);
  res.json({ valid: isValid });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const { sessionId } = req.body;
  activeSessions.delete(sessionId);
  res.json({ success: true });
});

// ===== TIMER STATE =====

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
    wasSkipped: false,
    autoExtendTime: null,
    language: timerState.language || 'de'
  };
  res.json(timerState);
});

// ===== TIMER AUTO-EXTEND LOGIC =====

// Check every second if timer needs auto-extension
setInterval(() => {
  if (!timerState.isRunning || timerState.isPaused) {
    return;
  }
  
  // Timer reached 0
  if (timerState.remaining <= 0 && !timerState.autoExtendTime) {
    // Start 30-second countdown for auto-extension
    timerState.autoExtendTime = Date.now() + 30000;
    console.log('Timer ended. Auto-extend in 30 seconds...');
  }
  
  // Check if 30 seconds passed and auto-extend
  if (timerState.autoExtendTime && Date.now() >= timerState.autoExtendTime) {
    const extension = 5 * 60; // 5 minutes in seconds
    timerState.duration += extension;
    timerState.remaining = extension;
    timerState.endTime = Date.now() + (extension * 1000);
    timerState.autoExtendTime = null;
    console.log('Timer auto-extended by 5 minutes');
  }
}, 1000);

// ===== POP-UP =====

// Pop-Up - Get available videos
app.get('/api/popup/videos', (req, res) => {
  const popDir = path.join(__dirname, 'public', 'pop');
  
  try {
    if (!fs.existsSync(popDir)) {
      fs.mkdirSync(popDir, { recursive: true });
      return res.json({ videos: [] });
    }
    
    const files = fs.readdirSync(popDir);
    const videos = files.filter(file => file.endsWith('.mp4'));
    
    res.json({ videos });
  } catch (err) {
    res.json({ videos: [], error: err.message });
  }
});

// Pop-Up - Get state
app.get('/api/popup/state', (req, res) => {
  res.json(popupState);
});

// Pop-Up - Update state
app.post('/api/popup/state', (req, res) => {
  popupState = { ...popupState, ...req.body };
  
  // If activating, start rotation
  if (popupState.isActive && popupState.selectedVideos.length > 0) {
    startVideoRotation();
  } else if (!popupState.isActive) {
    popupState.currentVideo = null;
    popupState.lastPlayedTime = null;
  }
  
  res.json(popupState);
});

// Pop-Up - Get current video
app.get('/api/popup/current', (req, res) => {
  res.json({ 
    currentVideo: popupState.currentVideo,
    isActive: popupState.isActive
  });
});

// Video rotation logic
function startVideoRotation() {
  if (!popupState.isActive || popupState.selectedVideos.length === 0) {
    return;
  }
  
  const now = Date.now();
  
  // Check if 10 minutes have passed since last video
  if (!popupState.lastPlayedTime || (now - popupState.lastPlayedTime >= VIDEO_INTERVAL)) {
    // Play next video
    const video = popupState.selectedVideos[popupState.currentVideoIndex];
    popupState.currentVideo = video;
    popupState.lastPlayedTime = now;
    
    // Move to next video (loop back to 0 after last)
    popupState.currentVideoIndex = (popupState.currentVideoIndex + 1) % popupState.selectedVideos.length;
    
    console.log(`Playing video: ${video} at ${new Date().toLocaleTimeString()}`);
  }
}

// Check video rotation every minute
setInterval(() => {
  if (popupState.isActive && popupState.selectedVideos.length > 0) {
    startVideoRotation();
  }
}, 60 * 1000);

// ===== SPOTIFY =====

// Spotify Auth - Step 1: Redirect to Spotify
app.get('/spotify/login', (req, res) => {
  const scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(authUrl);
});

// Spotify Auth - Step 2: Callback
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.send('Error: No code provided');
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      })
    });

    const data = await response.json();
    spotifyState.accessToken = data.access_token;
    spotifyState.refreshToken = data.refresh_token;

    res.send('<h1>✅ Spotify verbunden!</h1><p>Du kannst dieses Fenster schließen.</p><script>window.close()</script>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// Spotify - Get Current Track
app.get('/api/spotify/current', async (req, res) => {
  if (!spotifyState.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + spotifyState.accessToken }
    });

    if (response.status === 204) {
      return res.json({ isPlaying: false });
    }

    const data = await response.json();
    spotifyState.currentTrack = {
      name: data.item?.name,
      artist: data.item?.artists[0]?.name,
      album: data.item?.album?.name,
      cover: data.item?.album?.images[0]?.url,
      duration: data.item?.duration_ms,
      progress: data.progress_ms
    };
    spotifyState.isPlaying = data.is_playing;

    res.json(spotifyState.currentTrack);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Play/Pause
app.post('/api/spotify/playpause', async (req, res) => {
  if (!spotifyState.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const endpoint = spotifyState.isPlaying ? 'pause' : 'play';
    await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + spotifyState.accessToken }
    });

    spotifyState.isPlaying = !spotifyState.isPlaying;
    res.json({ success: true, isPlaying: spotifyState.isPlaying });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Skip
app.post('/api/spotify/skip', async (req, res) => {
  if (!spotifyState.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + spotifyState.accessToken }
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Set Volume
app.post('/api/spotify/volume', async (req, res) => {
  if (!spotifyState.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  const volume = req.body.volume;
  spotifyState.volume = volume;

  try {
    await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volume}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + spotifyState.accessToken }
    });

    res.json({ success: true, volume: volume });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Get Spotify State
app.get('/api/spotify/state', (req, res) => {
  res.json({
    connected: !!spotifyState.accessToken,
    volume: spotifyState.volume,
    isPlaying: spotifyState.isPlaying
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!TOTP_SECRET) {
    console.warn('⚠️  WARNING: TOTP_SECRET not set! Run setup-totp.js and add to Render environment.');
  } else {
    console.log('✅ TOTP_SECRET is set');
  }
});
