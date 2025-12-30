const express = require('express');
const fs = require('fs');
const path = require('path');
const speakeasy = require('speakeasy');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ===== AUTHENTICATION CONFIG =====
// If TOTP_SECRET is exactly "NONE", authentication is disabled
// Otherwise, TOTP authentication is required using the value from env
function isAuthEnabled() {
  const totpSecret = process.env.TOTP_SECRET;
  return totpSecret && totpSecret !== 'NONE';
}

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://lc5-streamdesk.onrender.com/callback';

const activeSessions = new Map();

// Single user state - no user ID needed
let userState = {
  timer: {
    duration: 0,
    remaining: 0,
    endTime: null,
    isPaused: false,
    isRunning: false,
    wasSkipped: false,
    language: 'de',
    autoExtendTime: null,
    lastUpdateTime: null // NEW: Track last update for accurate countdown
  },
  spotify: {
    accessToken: null,
    refreshToken: null,
    volume: 50,
    isPlaying: false,
    currentTrack: null
  },
  popup: {
    isActive: false,
    selectedVideos: [],
    currentVideoIndex: 0,
    currentVideo: null,
    lastPlayedTime: null
  }
};

const VIDEO_INTERVAL = 10 * 60 * 1000;

// ===== USER INFO =====
// Get user info from /user folder (PNG filename becomes display name)
function getUserInfo() {
  const userDir = path.join(__dirname, 'public', 'user');
  
  try {
    if (!fs.existsSync(userDir)) {
      return { name: 'Guest', avatar: 'none.png' };
    }
    
    const files = fs.readdirSync(userDir);
    const pngFile = files.find(file => file.endsWith('.png'));
    
    if (pngFile) {
      const name = path.basename(pngFile, '.png');
      return { name, avatar: pngFile };
    }
    
    return { name: 'Guest', avatar: 'none.png' };
  } catch (err) {
    console.error('Error reading user info:', err);
    return { name: 'Guest', avatar: 'none.png' };
  }
}

// ===== AUTHENTICATION =====

// Get instance info (no auth required - just tells auth status)
app.get('/api/instance/info', (req, res) => {
  const userInfo = getUserInfo();
  
  res.json({
    userName: userInfo.name,
    userAvatar: userInfo.avatar,
    authRequired: isAuthEnabled()
  });
});

app.post('/api/auth/verify', (req, res) => {
  const { code, sessionId } = req.body;
  const totpSecret = process.env.TOTP_SECRET; // Direct read from env
  const userInfo = getUserInfo();
  
  console.log('=== AUTH ATTEMPT ===');
  console.log('Received code:', code);
  console.log('Current user:', userInfo.name);
  console.log('TOTP_SECRET from env:', totpSecret);
  console.log('Auth status:', totpSecret === 'NONE' ? 'DISABLED' : 'ENABLED');
  
  // Check if auth is disabled (TOTP_SECRET is exactly "NONE")
  if (!totpSecret || totpSecret === 'NONE') {
    console.log('Auth disabled - auto-login');
    activeSessions.set(sessionId, true);
    return res.json({ 
      success: true, 
      user: { name: userInfo.name, avatar: userInfo.avatar } 
    });
  }
  
  // Verify TOTP code with the secret from environment
  const verified = speakeasy.totp.verify({
    secret: totpSecret,
    encoding: 'base32',
    token: code,
    window: 6
  });
  
  console.log('Verification result:', verified);
  console.log('===================');
  
  if (verified) {
    activeSessions.set(sessionId, true);
    res.json({ 
      success: true, 
      user: { name: userInfo.name, avatar: userInfo.avatar } 
    });
  } else {
    res.json({ success: false, error: 'Invalid code' });
  }
});

function getUserFromSession(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    return res.status(401).json({ error: 'No session' });
  }
  
  const isValid = activeSessions.get(sessionId);
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  
  next();
}

// ===== TIMER STATE =====

// NEW: Function to calculate current remaining time based on endTime
function calculateRemainingTime() {
  const timer = userState.timer;
  
  if (!timer.isRunning || timer.isPaused) {
    return timer.remaining;
  }
  
  if (!timer.endTime) {
    return timer.remaining;
  }
  
  const now = Date.now();
  const remaining = Math.max(0, Math.floor((timer.endTime - now) / 1000));
  
  return remaining;
}

// Public endpoint for countdown display (no auth required)
app.get('/api/state/public', (req, res) => {
  const timer = { ...userState.timer };
  
  // Grace period: 2 seconds after start
  if (timer.isRunning && !timer.isPaused && timer.endTime) {
    if (timer.lastUpdateTime) {
      const timeSinceStart = Date.now() - timer.lastUpdateTime;
      if (timeSinceStart > 2000) {
        // After 2 seconds: calculate
        timer.remaining = calculateRemainingTime();
      }
      // Within 2 seconds: use stored value
    } else {
      timer.remaining = calculateRemainingTime();
    }
  }
  
  res.json(timer);
});

app.get('/api/state', getUserFromSession, (req, res) => {
  const timer = { ...userState.timer };
  
  // Grace period: 2 seconds after start
  if (timer.isRunning && !timer.isPaused && timer.endTime) {
    if (timer.lastUpdateTime) {
      const timeSinceStart = Date.now() - timer.lastUpdateTime;
      if (timeSinceStart > 2000) {
        // After 2 seconds: calculate
        timer.remaining = calculateRemainingTime();
      }
      // Within 2 seconds: use stored value
    } else {
      timer.remaining = calculateRemainingTime();
    }
  }
  
  res.json(timer);
});

app.post('/api/state', getUserFromSession, (req, res) => {
  const updates = req.body;
  
  // If starting a new timer
  if (updates.isRunning && updates.endTime && updates.remaining) {
    // Set grace period timestamp
    updates.lastUpdateTime = Date.now();
  }
  
  // If pausing, save current remaining time
  if (updates.isPaused !== undefined && updates.isPaused === true) {
    const currentRemaining = calculateRemainingTime();
    updates.remaining = currentRemaining;
    updates.endTime = null;
    updates.lastUpdateTime = null; // Clear grace period
  }
  
  // If resuming, recalculate endTime based on remaining
  if (updates.isPaused !== undefined && updates.isPaused === false && userState.timer.isPaused) {
    const currentRemaining = userState.timer.remaining;
    updates.endTime = Date.now() + (currentRemaining * 1000);
    updates.lastUpdateTime = Date.now(); // Restart grace period
  }
  
  userState.timer = { ...userState.timer, ...updates };
  res.json(userState.timer);
});

app.post('/api/reset', getUserFromSession, (req, res) => {
  const wasRunning = userState.timer.isRunning && userState.timer.remaining > 0;
  
  userState.timer = {
    duration: 0,
    remaining: 0,
    endTime: null,
    isPaused: false,
    isRunning: false,
    wasSkipped: wasRunning,
    autoExtendTime: null,
    lastUpdateTime: null,
    language: userState.timer.language || 'de'
  };
  res.json(userState.timer);
});

// Timer countdown and auto-extend logic
setInterval(() => {
  const timer = userState.timer;
  
  if (!timer.isRunning || timer.isPaused) {
    return;
  }
  
  // GRACE PERIOD: Don't update during first 2 seconds!
  if (timer.lastUpdateTime) {
    const timeSinceStart = Date.now() - timer.lastUpdateTime;
    if (timeSinceStart < 2000) {
      // Still in grace period - don't touch anything!
      return;
    }
  }
  
  // Update remaining time based on endTime
  const newRemaining = calculateRemainingTime();
  
  // Only update if changed
  if (timer.remaining !== newRemaining) {
    timer.remaining = newRemaining;
  }
  
  // Auto-extend after timer reaches 0
  if (timer.remaining <= 0 && !timer.autoExtendTime) {
    timer.autoExtendTime = Date.now() + 30000;
    console.log('Timer ended. Auto-extend in 30 seconds...');
  }
  
  if (timer.autoExtendTime && Date.now() >= timer.autoExtendTime) {
    const extension = 5 * 60;
    timer.duration += extension;
    timer.remaining = extension;
    timer.endTime = Date.now() + (extension * 1000);
    timer.autoExtendTime = null;
    timer.lastUpdateTime = Date.now();
    console.log('Timer auto-extended by 5 minutes');
  }
}, 1000);

// ===== POP-UP =====

app.get('/api/popup/videos', getUserFromSession, (req, res) => {
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

app.get('/api/popup/state', getUserFromSession, (req, res) => {
  res.json(userState.popup);
});

app.post('/api/popup/state', getUserFromSession, (req, res) => {
  userState.popup = { ...userState.popup, ...req.body };
  
  if (userState.popup.isActive && userState.popup.selectedVideos.length > 0) {
    startVideoRotation();
  } else if (!userState.popup.isActive) {
    userState.popup.currentVideo = null;
    userState.popup.lastPlayedTime = null;
  }
  
  res.json(userState.popup);
});

// Public endpoint for popup display
app.get('/api/popup/current', (req, res) => {
  res.json({ 
    currentVideo: userState.popup.currentVideo,
    isActive: userState.popup.isActive
  });
});

function startVideoRotation() {
  const popup = userState.popup;
  
  if (!popup.isActive || popup.selectedVideos.length === 0) {
    return;
  }
  
  const now = Date.now();
  
  if (!popup.lastPlayedTime || (now - popup.lastPlayedTime >= VIDEO_INTERVAL)) {
    const video = popup.selectedVideos[popup.currentVideoIndex];
    popup.currentVideo = video;
    popup.lastPlayedTime = now;
    
    popup.currentVideoIndex = (popup.currentVideoIndex + 1) % popup.selectedVideos.length;
    
    console.log(`Playing video: ${video} at ${new Date().toLocaleTimeString()}`);
  }
}

setInterval(() => {
  if (userState.popup.isActive && userState.popup.selectedVideos.length > 0) {
    startVideoRotation();
  }
}, 60 * 1000);

// ===== SPOTIFY =====

// Public endpoint for music visualizer
app.get('/api/spotify/current/public', async (req, res) => {
  if (!userState.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + userState.spotify.accessToken }
    });

    if (response.status === 204) {
      return res.json({ isPlaying: false });
    }

    const data = await response.json();
    userState.spotify.currentTrack = {
      name: data.item?.name,
      artist: data.item?.artists[0]?.name,
      album: data.item?.album?.name,
      cover: data.item?.album?.images[0]?.url,
      duration: data.item?.duration_ms,
      progress: data.progress_ms
    };
    userState.spotify.isPlaying = data.is_playing;

    res.json(userState.spotify.currentTrack);
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/spotify/login', getUserFromSession, (req, res) => {
  const scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
  res.redirect(authUrl);
});

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
    userState.spotify.accessToken = data.access_token;
    userState.spotify.refreshToken = data.refresh_token;

    res.send('<h1>✅ Spotify verbunden!</h1><p>Du kannst dieses Fenster schließen.</p><script>window.close()</script>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

app.get('/api/spotify/current', getUserFromSession, async (req, res) => {
  if (!userState.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + userState.spotify.accessToken }
    });

    if (response.status === 204) {
      return res.json({ isPlaying: false });
    }

    const data = await response.json();
    userState.spotify.currentTrack = {
      name: data.item?.name,
      artist: data.item?.artists[0]?.name,
      album: data.item?.album?.name,
      cover: data.item?.album?.images[0]?.url,
      duration: data.item?.duration_ms,
      progress: data.progress_ms
    };
    userState.spotify.isPlaying = data.is_playing;

    res.json(userState.spotify.currentTrack);
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/api/spotify/playpause', getUserFromSession, async (req, res) => {
  if (!userState.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const endpoint = userState.spotify.isPlaying ? 'pause' : 'play';
    await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + userState.spotify.accessToken }
    });

    userState.spotify.isPlaying = !userState.spotify.isPlaying;
    res.json({ success: true, isPlaying: userState.spotify.isPlaying });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/api/spotify/skip', getUserFromSession, async (req, res) => {
  if (!userState.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + userState.spotify.accessToken }
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/api/spotify/volume', getUserFromSession, async (req, res) => {
  if (!userState.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  const volume = req.body.volume;
  userState.spotify.volume = volume;

  try {
    await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volume}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + userState.spotify.accessToken }
    });

    res.json({ success: true, volume: volume });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/spotify/state', getUserFromSession, (req, res) => {
  res.json({
    connected: !!userState.spotify.accessToken,
    volume: userState.spotify.volume,
    isPlaying: userState.spotify.isPlaying
  });
});

app.listen(PORT, () => {
  const userInfo = getUserInfo();
  const totpSecret = process.env.TOTP_SECRET;
  
  console.log(`Server running on port ${PORT}`);
  console.log(`Current user: ${userInfo.name}`);
  console.log(`TOTP_SECRET value: ${totpSecret ? (totpSecret === 'NONE' ? 'NONE (Auth disabled)' : '[SET]') : '[NOT SET - Auth disabled]'}`);
  console.log(`Auth: ${isAuthEnabled() ? 'ENABLED' : 'DISABLED'}`);
});
