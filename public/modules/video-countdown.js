// ==========================================
// ENTERTAINMENT LOGIC
// Dynamically loaded by countdown.html when entertainment is enabled
// ==========================================

(function() {
  console.log('[ENTERTAIN] Logic script loaded');

  // State
  let allVideos = [];
  let availableVideos = [];
  let usedVideos = [];
  let currentPlaylist = [];
  let currentVideoIndex = 0;
  let phase = 'idle'; // idle, intro, playing, transition, outro
  let phaseStartTime = null;
  let videoDurations = new Map();
  let isProcessing = false;

  // DOM Elements (will be created)
  let videoPlayer = null;
  let videoElement = null;

  // Create video player overlay
  function createVideoPlayer() {
    if (videoPlayer) return;

    videoPlayer = document.createElement('div');
    videoPlayer.id = 'entertainment-video-player';
    videoPlayer.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: black;
      opacity: 0;
      transition: opacity 2s ease-in-out;
      z-index: 5;
      display: none;
    `;

    videoElement = document.createElement('video');
    videoElement.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: contain;
    `;
    videoElement.muted = true;

    videoPlayer.appendChild(videoElement);
    document.body.appendChild(videoPlayer);

    console.log('[ENTERTAIN] Video player created');
  }

  // Load video metadata
  function loadVideoMetadata(videoPath) {
    return new Promise((resolve) => {
      const tempVideo = document.createElement('video');
      tempVideo.src = `/vids/${videoPath}`;

      tempVideo.addEventListener('loadedmetadata', () => {
        const duration = Math.floor(tempVideo.duration);
        videoDurations.set(videoPath, duration);
        console.log(`[ENTERTAIN] Loaded: ${videoPath} (${duration}s)`);
        resolve(duration);
      });

      tempVideo.addEventListener('error', () => {
        console.error(`[ENTERTAIN] Error loading: ${videoPath}`);
        resolve(0);
      });
    });
  }

  // Scan all videos
  async function scanAllVideos() {
    try {
      const res = await fetch(`${window.API_URL}/api/entertaining/videos`);
      const data = await res.json();
      allVideos = data.videos || [];

      console.log(`[ENTERTAIN] Scanning ${allVideos.length} videos...`);

      for (const video of allVideos) {
        await loadVideoMetadata(video.path);
      }

      console.log(`[ENTERTAIN] Scan complete! ${videoDurations.size} videos ready`);
    } catch (err) {
      console.error('[ENTERTAIN] Scan error:', err);
    }
  }

  // Knapsack algorithm - find best video combination
  function findBestVideoCombination(targetTime, videos) {
    if (videos.length === 0 || targetTime <= 0) return [];

    const validVideos = videos.filter(v => 
      videoDurations.has(v.path) && videoDurations.get(v.path) > 0
    );

    if (validVideos.length === 0) return [];

    const sorted = [...validVideos].sort((a, b) => 
      videoDurations.get(b.path) - videoDurations.get(a.path)
    );

    const selected = [];
    let remaining = targetTime;

    for (const video of sorted) {
      const duration = videoDurations.get(video.path);
      if (duration <= remaining) {
        selected.push(video);
        remaining -= duration;

        if (remaining <= 0) break;
      }
    }

    return selected;
  }

  // Play video
  function playVideo(videoPath) {
    return new Promise((resolve) => {
      videoElement.src = `/vids/${videoPath}`;
      videoPlayer.style.display = 'block';
      
      setTimeout(() => {
        videoPlayer.style.opacity = '1';
      }, 50);
      
      videoElement.play();

      videoElement.onended = () => {
        console.log(`[ENTERTAIN] Video ended: ${videoPath}`);
        resolve();
      };
    });
  }

  // Fade out video
  function fadeOutVideo() {
    return new Promise((resolve) => {
      videoPlayer.style.transition = 'opacity 5s ease-in-out';
      videoPlayer.style.opacity = '0';

      setTimeout(() => {
        videoPlayer.style.display = 'none';
        videoPlayer.style.transition = 'opacity 2s ease-in-out';
        videoElement.pause();
        videoElement.src = '';
        resolve();
      }, 5000);
    });
  }

  // Main entertainment loop
  async function entertainmentLoop(timerState, isEnabled) {
    if (isProcessing) return;
    isProcessing = true;

    try {
      // Get used videos from server
      const stateRes = await fetch(`${window.API_URL}/api/entertaining/public`);
      const state = await stateRes.json();
      usedVideos = state.usedVideos || [];

      // Not enabled or timer not running
      if (!isEnabled || !timerState.isRunning || timerState.remaining <= 0) {
        if (phase !== 'idle') {
          console.log('[ENTERTAIN] Stopping...');
          await fadeOutVideo();
          
          // Signal countdown to go large
          if (window.entertainmentTimerControl) {
            window.entertainmentTimerControl.makeTimerLarge();
          }
          
          phase = 'idle';
          currentPlaylist = [];
          currentVideoIndex = 0;
        }
        isProcessing = false;
        return;
      }

      // Timer just started
      if (phase === 'idle' && timerState.remaining > 0) {
        console.log('[ENTERTAIN] Starting...');
        phase = 'intro';
        phaseStartTime = Date.now();

        // Signal countdown to stay large
        if (window.entertainmentTimerControl) {
          window.entertainmentTimerControl.makeTimerLarge();
        }

        // Calculate available time
        const availableTime = timerState.duration - 20; // -10s start, -10s end

        // Filter available videos
        availableVideos = allVideos.filter(v => 
          !usedVideos.includes(v.path) && videoDurations.has(v.path)
        );

        // Account for transitions (10s per video)
        const estimatedVideos = Math.max(1, Math.floor(availableTime / 30));
        const timeForVideos = availableTime - (estimatedVideos * 10);

        // Find best combination
        currentPlaylist = findBestVideoCombination(timeForVideos, availableVideos);
        currentVideoIndex = 0;

        console.log(`[ENTERTAIN] Playlist: ${currentPlaylist.length} videos`);
        currentPlaylist.forEach((v, i) => {
          console.log(`  ${i + 1}. ${v.filename} (${videoDurations.get(v.path)}s)`);
        });
      }

      // Intro phase (first 10 seconds)
      if (phase === 'intro') {
        const elapsed = Math.floor((Date.now() - phaseStartTime) / 1000);

        if (elapsed >= 10) {
          console.log('[ENTERTAIN] Intro complete, starting videos');
          
          // Signal countdown to go small
          if (window.entertainmentTimerControl) {
            window.entertainmentTimerControl.makeTimerSmall();
          }

          if (currentPlaylist.length > 0) {
            phase = 'playing';
            const video = currentPlaylist[currentVideoIndex];
            
            // Mark as used
            await fetch(`${window.API_URL}/api/entertaining/mark-used`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ videoPath: video.path })
            });

            await playVideo(video.path);
            
            currentVideoIndex++;
            phase = 'transition';
            phaseStartTime = Date.now();
          } else {
            console.log('[ENTERTAIN] No videos in playlist, entering outro');
            phase = 'outro';
          }
        }
      }

      // Transition phase (between videos)
      if (phase === 'transition') {
        const elapsed = Math.floor((Date.now() - phaseStartTime) / 1000);

        if (elapsed < 5) {
          // Fade out video, timer goes large
          if (window.entertainmentTimerControl) {
            window.entertainmentTimerControl.makeTimerLarge();
          }
        } else if (elapsed >= 10) {
          // Check if more videos fit
          const timeLeft = timerState.remaining - 10; // reserve 10s for outro

          if (currentVideoIndex < currentPlaylist.length) {
            const nextVideo = currentPlaylist[currentVideoIndex];
            const videoDuration = videoDurations.get(nextVideo.path);

            if (videoDuration && videoDuration <= timeLeft - 10) {
              console.log(`[ENTERTAIN] Playing next: ${nextVideo.filename}`);
              phase = 'playing';
              
              // Signal countdown to go small
              if (window.entertainmentTimerControl) {
                window.entertainmentTimerControl.makeTimerSmall();
              }

              // Mark as used
              await fetch(`${window.API_URL}/api/entertaining/mark-used`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoPath: nextVideo.path })
              });

              await playVideo(nextVideo.path);
              
              currentVideoIndex++;
              phase = 'transition';
              phaseStartTime = Date.now();
            } else {
              console.log('[ENTERTAIN] No time for next video, entering outro');
              phase = 'outro';
              await fadeOutVideo();
              
              if (window.entertainmentTimerControl) {
                window.entertainmentTimerControl.makeTimerLarge();
              }
            }
          } else {
            console.log('[ENTERTAIN] Playlist complete, entering outro');
            phase = 'outro';
            await fadeOutVideo();
            
            if (window.entertainmentTimerControl) {
              window.entertainmentTimerControl.makeTimerLarge();
            }
          }
        }
      }

      // Outro phase (last 10 seconds)
      if (phase === 'outro' || timerState.remaining <= 10) {
        if (phase !== 'outro') {
          console.log('[ENTERTAIN] Entering outro');
          phase = 'outro';
          await fadeOutVideo();
          
          if (window.entertainmentTimerControl) {
            window.entertainmentTimerControl.makeTimerLarge();
          }
        }
      }

    } catch (err) {
      console.error('[ENTERTAIN] Loop error:', err);
    }

    isProcessing = false;
  }

  // Reset handler
  async function resetEntertainment() {
    console.log('[ENTERTAIN] Reset triggered');
    
    if (phase !== 'idle') {
      await fadeOutVideo();
      
      if (window.entertainmentTimerControl) {
        window.entertainmentTimerControl.makeTimerLarge();
      }
      
      phase = 'idle';
      currentPlaylist = [];
      currentVideoIndex = 0;

      // Reset used videos
      try {
        await fetch(`${window.API_URL}/api/entertaining/reset-used`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.error('[ENTERTAIN] Reset error:', err);
      }
    }
  }

  // Initialize
  async function initialize() {
    console.log('[ENTERTAIN] Initializing entertainment logic...');
    createVideoPlayer();
    await scanAllVideos();
    console.log('[ENTERTAIN] Ready!');
  }

  // Export public API
  window.entertainmentLogic = {
    initialize,
    entertainmentLoop,
    reset: resetEntertainment,
    isActive: () => phase !== 'idle'
  };

  // Auto-initialize
  initialize();
})();
