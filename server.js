const express = require('express');
const path = require('path');
const fs = require('fs');
const speakeasy = require('speakeasy');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================

const TOTP_SECRET = process.env.TOTP_SECRET || 'NONE';
const AUTH_REQUIRED = TOTP_SECRET !== 'NONE';

// ============================================
// STATE STORAGE (Module will populate this)
// ============================================

let sessionStore = {};
let moduleStates = {}; // Each module stores its state here

// ============================================
// AUTH MIDDLEWARE
// ============================================

function getUserFromSession(req, res, next) {
  if (!AUTH_REQUIRED) {
    req.user = { name: 'Guest', avatar: 'none.png' };
    return next();
  }
  
  const sessionId = req.headers['x-session-id'];
  
  if (!sessionId || !sessionStore[sessionId]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  req.user = sessionStore[sessionId];
  next();
}

// ============================================
// AUTH ROUTES (Core - not modular)
// ============================================

app.get('/api/instance/info', (req, res) => {
  res.json({
    authRequired: AUTH_REQUIRED
  });
});

app.post('/api/auth/verify', (req, res) => {
  const { code, sessionId } = req.body;
  
  if (!AUTH_REQUIRED) {
    const user = { name: 'Guest', avatar: 'none.png' };
    sessionStore[sessionId] = user;
    return res.json({ success: true, user });
  }
  
  const verified = speakeasy.totp.verify({
    secret: TOTP_SECRET,
    encoding: 'base32',
    token: code,
    window: 2
  });
  
  if (verified) {
    const userFiles = fs.readdirSync(path.join(__dirname, 'public', 'user'))
      .filter(f => f.endsWith('.png'));
    
    const avatarFile = userFiles.length > 0 ? userFiles[0] : 'none.png';
    const userName = avatarFile.replace('.png', '');
    
    const user = { name: userName, avatar: avatarFile };
    sessionStore[sessionId] = user;
    
    console.log(`[AUTH] User logged in: ${userName}`);
    return res.json({ success: true, user });
  }
  
  res.json({ success: false });
});

// ============================================
// MODULE LOADER
// ============================================

const loadedModules = [];

function loadModulesFromHTML() {
  const publicDir = path.join(__dirname, 'public');
  const files = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
  
  console.log('[MODULE LOADER] Scanning for modules...');
  
  files.forEach(file => {
    const filePath = path.join(publicDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    // Extract module config
    const configMatch = content.match(/<script type="application\/json" id="module-config">\s*([\s\S]*?)\s*<\/script>/);
    if (!configMatch) return;
    
    try {
      const config = JSON.parse(configMatch[1]);
      
      // Extract server routes
      const serverMatch = content.match(/<script type="text\/x-server-module">\s*([\s\S]*?)\s*<\/script>/);
      
      if (serverMatch) {
        const module = {
          id: config.id,
          priority: config.priority || 99,
          config: config,
          file: file,
          serverCode: serverMatch[1]
        };
        
        loadedModules.push(module);
        console.log(`[MODULE LOADER] ✅ Loaded: ${config.name} (Priority: ${config.priority})`);
      }
    } catch (err) {
      console.error(`[MODULE LOADER] ❌ Error loading ${file}:`, err.message);
    }
  });
  
  // Sort by priority
  loadedModules.sort((a, b) => a.priority - b.priority);
  
  console.log(`[MODULE LOADER] Total modules loaded: ${loadedModules.length}`);
}

function registerModuleRoutes() {
  loadedModules.forEach(module => {
    try {
      console.log(`[MODULE LOADER] Registering routes for: ${module.id}`);
      
      // Create isolated scope for module
      const moduleScope = {
        app: app,
        express: express,
        getUserFromSession: getUserFromSession,
        moduleStates: moduleStates,
        path: path,
        fs: fs,
        __dirname: __dirname,
        console: console,
        require: require,
        process: process,
        Buffer: Buffer,
        Date: Date,
        Math: Math,
        JSON: JSON,
        setTimeout: setTimeout,
        setInterval: setInterval,
        clearTimeout: clearTimeout,
        clearInterval: clearInterval
      };
      
      // Execute module server code in isolated scope
      const moduleFunction = new Function(
        ...Object.keys(moduleScope),
        module.serverCode
      );
      
      moduleFunction(...Object.values(moduleScope));
      
      console.log(`[MODULE LOADER] ✅ Routes registered for: ${module.id}`);
    } catch (err) {
      console.error(`[MODULE LOADER] ❌ Error registering routes for ${module.id}:`, err.message);
    }
  });
}

// ============================================
// MODULE API (for Controller to fetch modules)
// ============================================

app.get('/api/modules/list', (req, res) => {
  const moduleList = loadedModules.map(m => ({
    id: m.config.id,
    name: m.config.name,
    priority: m.config.priority,
    borderColor: m.config.borderColor,
    activeColor: m.config.activeColor,
    hasOverlay: m.config.hasOverlay || false,
    overlayUrl: m.config.overlayUrl || null,
    dependencies: m.config.dependencies || [],
    file: m.file
  }));
  
  res.json({ modules: moduleList });
});

app.get('/api/modules/:moduleId', (req, res) => {
  const moduleId = req.params.moduleId;
  const module = loadedModules.find(m => m.id === moduleId);
  
  if (!module) {
    return res.status(404).json({ error: 'Module not found' });
  }
  
  // Read HTML file and extract controller code
  const filePath = path.join(__dirname, 'public', module.file);
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const controllerMatch = content.match(/<script type="text\/x-controller-module">\s*([\s\S]*?)\s*<\/script>/);
  
  res.json({
    id: module.id,
    config: module.config,
    controllerCode: controllerMatch ? controllerMatch[1] : null
  });
});

// ============================================
// LOAD & REGISTER MODULES
// ============================================

loadModulesFromHTML();
registerModuleRoutes();

// ============================================
// SERVER START
// ============================================

app.listen(PORT, () => {
  console.log(`🚀 StreamDesk V13 Modular running on port ${PORT}`);
  console.log(`🔐 Auth: ${AUTH_REQUIRED ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📦 Modules loaded: ${loadedModules.length}`);
  loadedModules.forEach(m => {
    console.log(`   - ${m.config.name} (${m.id}) - Priority ${m.priority}`);
  });
});
