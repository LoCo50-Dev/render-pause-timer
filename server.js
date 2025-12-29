const express = require('express');
const fs = require('fs');
const path = require('path');
const speakeasy = require('speakeasy');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// ===== USER CONFIGURATION =====
// Füge hier neue User hinzu. Jeder User braucht:
// - id: Eindeutiger Code (wird für Ordner verwendet, z.B. "SD-A98DB")
// - name: Anzeigename (wird im UI angezeigt, z.B. "@ExplorerLoCo50")
// - ytId: Wird automatisch aus process.env.YT_ID geladen
const USERS = [
  {
    id: 'SD-A98DB',
    name: '@ExplorerLoCo50',
    ytId: process.env.YT_ID || 'none'
  },
  {
    id: 'none',
    name: 'Guest',
    ytId: 'none'
  }
  // Weitere User hier hinzufügen:
  // {
  //   id: 'SD-XYZ123',
  //   name: '@AnotherStreamer',
  //   ytId: process.env.YT_ID || 'none'
  // }
];

// TOTP Configuration - Setze "NONE" um Passwort zu deaktivieren
const TOTP_SECRET = process.env.TOTP_SECRET;
const AUTH_DISABLED = TOTP_SECRET === 'NONE';

// Spotify API Configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://lc5-streamdesk.onrender.com/callback';

// Session Store
const activeSessions = new Map();

// In-Memory State (per user)
const userStates = new Map();

function getUserState(userId) {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      timer: {
        duration: 0,
        remaining: 0,
        endTime: null,
        isPaused: false,
        isRunning: false,
        wasSkipped: false,
        language: 'de',
        autoExtendTime: null
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
    });
  }
  return userStates.get(userId);
}

// Video rotation interval (10 minutes)
const VIDEO_INTERVAL = 10 * 60 * 1000;

// ===== AUTHENTICATION =====

// Verify TOTP Code
app.post('/api/auth/verify', (req, res) => {
  const { code, sessionId } = req.body;
  
  // If auth is disabled, auto-approve with YT_ID user
  if (AUTH_DISABLED) {
    const ytId = process.env.YT_ID || 'none';
    const user = USERS.find(u => u.ytId === ytId) || USERS.find(u => u.id === 'none');
    activeSessions.set(sessionId, user.id);
    return res.json({ 
      success: true, 
      user: { id: user.id, name: user.name, ytId: user.ytId } 
    });
  }
  
  console.log('=== AUTH ATTEMPT ===');
  console.log('Received code:', code);
  
  if (!TOTP_SECRET) {
    console.log('ERROR: TOTP_SECRET not set');
    return res.json({ success: false, error: 'Server not configured' });
  }
  
  const verified = speakeasy.totp.verify({
    secret: TOTP_SECRET,
    encoding: 'base32',
    token: code,
    window: 6
  });
  
  console.log('Verification result:', verified);
  console.log('===================');
  
  if (verified) {
    const ytId = process.env.YT_ID || 'none';
    const user = USERS.find(u => u.ytId === ytId) || USERS.find(u => u.id === 'none');
    activeSessions.set(sessionId, user.id);
    res.json({ 
      success: true, 
      user: { id: user.id, name: user.name, ytId: user.ytId } 
    });
  } else {
    res.json({ success: false, error: 'Invalid code' });
  }
});

// Check if session is valid
app.post('/api/auth/check', (req, res) => {
  const { sessionId } = req.body;
  
  // Sessions expire on every new page load - always return invalid
  res.json({ valid: false });
});

// Get current user info
app.get('/api/auth/user', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId) {
    return res.status(401).json({ error: 'No session' });
  }
  
  const userId = activeSessions.get(sessionId);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  
  const user = USERS.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({
    id: user.id,
    name: user.name,
    ytId: user.ytId
  });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const { sessionId } = req.body;
  activeSessions.delete(sessionId);
  res.json({ success: true });
});

// Middleware to get userId from session
function getUserFromSession(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    return res.status(401).json({ error: 'No session' });
  }
  
  const userId = activeSessions.get(sessionId);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid session' });
  }
  
  req.userId = userId;
  next();
}

// ===== TIMER STATE =====

// GET State
app.get('/api/state', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  res.json(state.timer);
});

// POST Update State
app.post('/api/state', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  state.timer = { ...state.timer, ...req.body };
  res.json(state.timer);
});

// Reset State
app.post('/api/reset', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  state.timer = {
    duration: 0,
    remaining: 0,
    endTime: null,
    isPaused: false,
    isRunning: false,
    wasSkipped: false,
    autoExtendTime: null,
    language: state.timer.language || 'de'
  };
  res.json(state.timer);
});

// ===== TIMER AUTO-EXTEND LOGIC =====

setInterval(() => {
  userStates.forEach((state, userId) => {
    const timer = state.timer;
    
    if (!timer.isRunning || timer.isPaused) {
      return;
    }
    
    if (timer.remaining <= 0 && !timer.autoExtendTime) {
      timer.autoExtendTime = Date.now() + 30000;
      console.log(`[${userId}] Timer ended. Auto-extend in 30 seconds...`);
    }
    
    if (timer.autoExtendTime && Date.now() >= timer.autoExtendTime) {
      const extension = 5 * 60;
      timer.duration += extension;
      timer.remaining = extension;
      timer.endTime = Date.now() + (extension * 1000);
      timer.autoExtendTime = null;
      console.log(`[${userId}] Timer auto-extended by 5 minutes`);
    }
  });
}, 1000);

// ===== POP-UP =====

// Pop-Up - Get available videos for user
app.get('/api/popup/videos', getUserFromSession, (req, res) => {
  const userId = req.userId;
  const popDir = path.join(__dirname, 'public', 'pop', userId);
  
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
app.get('/api/popup/state', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  res.json(state.popup);
});

// Pop-Up - Update state
app.post('/api/popup/state', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  state.popup = { ...state.popup, ...req.body };
  
  if (state.popup.isActive && state.popup.selectedVideos.length > 0) {
    startVideoRotation(req.userId);
  } else if (!state.popup.isActive) {
    state.popup.currentVideo = null;
    state.popup.lastPlayedTime = null;
  }
  
  res.json(state.popup);
});

// Pop-Up - Get current video (public endpoint for popup.html)
app.get('/api/popup/current/:userId', (req, res) => {
  const state = getUserState(req.params.userId);
  res.json({ 
    currentVideo: state.popup.currentVideo,
    isActive: state.popup.isActive,
    userId: req.params.userId
  });
});

// Video rotation logic
function startVideoRotation(userId) {
  const state = getUserState(userId);
  const popup = state.popup;
  
  if (!popup.isActive || popup.selectedVideos.length === 0) {
    return;
  }
  
  const now = Date.now();
  
  if (!popup.lastPlayedTime || (now - popup.lastPlayedTime >= VIDEO_INTERVAL)) {
    const video = popup.selectedVideos[popup.currentVideoIndex];
    popup.currentVideo = video;
    popup.lastPlayedTime = now;
    
    popup.currentVideoIndex = (popup.currentVideoIndex + 1) % popup.selectedVideos.length;
    
    console.log(`[${userId}] Playing video: ${video} at ${new Date().toLocaleTimeString()}`);
  }
}

// Check video rotation every minute
setInterval(() => {
  userStates.forEach((state, userId) => {
    if (state.popup.isActive && state.popup.selectedVideos.length > 0) {
      startVideoRotation(userId);
    }
  });
}, 60 * 1000);

// ===== SPOTIFY =====

// Spotify Auth - Step 1: Redirect to Spotify
app.get('/spotify/login', getUserFromSession, (req, res) => {
  const scopes = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${req.userId}`;
  res.redirect(authUrl);
});

// Spotify Auth - Step 2: Callback
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const userId = req.query.state;
  
  if (!code || !userId) {
    return res.send('Error: No code or user provided');
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
    const state = getUserState(userId);
    state.spotify.accessToken = data.access_token;
    state.spotify.refreshToken = data.refresh_token;

    res.send('<h1>✅ Spotify verbunden!</h1><p>Du kannst dieses Fenster schließen.</p><script>window.close()</script>');
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// Spotify - Get Current Track
app.get('/api/spotify/current', getUserFromSession, async (req, res) => {
  const state = getUserState(req.userId);
  
  if (!state.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { 'Authorization': 'Bearer ' + state.spotify.accessToken }
    });

    if (response.status === 204) {
      return res.json({ isPlaying: false });
    }

    const data = await response.json();
    state.spotify.currentTrack = {
      name: data.item?.name,
      artist: data.item?.artists[0]?.name,
      album: data.item?.album?.name,
      cover: data.item?.album?.images[0]?.url,
      duration: data.item?.duration_ms,
      progress: data.progress_ms
    };
    state.spotify.isPlaying = data.is_playing;

    res.json(state.spotify.currentTrack);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Play/Pause
app.post('/api/spotify/playpause', getUserFromSession, async (req, res) => {
  const state = getUserState(req.userId);
  
  if (!state.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    const endpoint = state.spotify.isPlaying ? 'pause' : 'play';
    await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + state.spotify.accessToken }
    });

    state.spotify.isPlaying = !state.spotify.isPlaying;
    res.json({ success: true, isPlaying: state.spotify.isPlaying });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Skip
app.post('/api/spotify/skip', getUserFromSession, async (req, res) => {
  const state = getUserState(req.userId);
  
  if (!state.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  try {
    await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + state.spotify.accessToken }
    });

    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Spotify - Set Volume
app.post('/api/spotify/volume', getUserFromSession, async (req, res) => {
  const state = getUserState(req.userId);
  
  if (!state.spotify.accessToken) {
    return res.json({ error: 'Not authenticated' });
  }

  const volume = req.body.volume;
  state.spotify.volume = volume;

  try {
    await fetch(`https://api.spotify.com/v1/me/player/volume?volume_percent=${volume}`, {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + state.spotify.accessToken }
    });

    res.json({ success: true, volume: volume });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Get Spotify State
app.get('/api/spotify/state', getUserFromSession, (req, res) => {
  const state = getUserState(req.userId);
  res.json({
    connected: !!state.spotify.accessToken,
    volume: state.spotify.volume,
    isPlaying: state.spotify.isPlaying
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Auth mode: ${AUTH_DISABLED ? 'DISABLED (TOTP_SECRET=NONE)' : 'ENABLED'}`);
  console.log(`YT_ID from env: ${process.env.YT_ID || 'none'}`);
  console.log(`Registered users: ${USERS.map(u => `${u.name} (${u.id})`).join(', ')}`);
});
