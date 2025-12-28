let overlayInterval, controllerInterval;

// Overlay-Funktion
function startOverlay(){
  const countdownEl = document.getElementById("countdown");
  const returnEl = document.getElementById("returnTime");

  overlayInterval = setInterval(async ()=>{
    const status = await fetch("/api/status").then(r=>r.json());
    if(!status.running && !status.paused){
      countdownEl.innerText = "0:00";
      returnEl.innerText = "End: --:--";
      return;
    }

    let remaining = status.paused ? status.remainingMs : status.endTime - Date.now();
    if(remaining<0) remaining=0;

    const mins = Math.floor(remaining/60000);
    const secs = Math.floor((remaining%60000)/1000);
    countdownEl.innerText = `${mins}:${secs.toString().padStart(2,"0")}`;

    const endTime = status.paused ? new Date(Date.now()+status.remainingMs) : new Date(status.endTime);
    returnEl.innerText = `End: ${endTime.getHours().toString().padStart(2,"0")}:${endTime.getMinutes().toString().padStart(2,"0")}`;
  },1000);
}

// Controller-Funktion
function startController(){
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const minutesInput = document.getElementById("minutes");

  async function refreshStatus(){
    const status = await fetch("/api/status").then(r=>r.json());
    if(!status.running && !status.paused){
      pauseBtn.disabled = true;
      startBtn.innerText = "Start";
    } else {
      pauseBtn.disabled = false;
      startBtn.innerText = "Reset";
      pauseBtn.innerText = status.paused ? "Resume" : "Pause";
    }
  }

  overlayInterval = setInterval(refreshStatus,1000);

  window.startTimer = async ()=>{
    const mins = Number(minutesInput.value) || 20;
    await fetch("/api/start",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({minutes:mins})
    });
    refreshStatus();
  }

  window.togglePause = async ()=>{
    const status = await fetch("/api/status").then(r=>r.json());
    if(status.paused){
      await fetch("/api/resume",{method:"POST"});
    } else {
      await fetch("/api/pause",{method:"POST"});
    }
    refreshStatus();
  }

  startBtn.addEventListener("click", async ()=>{
    const status = await fetch("/api/status").then(r=>r.json());
    if(status.running || status.paused){
      await fetch("/api/reset",{method:"POST"});
    } else {
      startTimer();
    }
    refreshStatus();
  });
}

