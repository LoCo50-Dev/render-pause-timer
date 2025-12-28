let progressInterval;

function startController(){
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const minutesInput = document.getElementById("minutes");
  const returnEl = document.getElementById("returnTime");

  async function refreshStatus(){
    const status = await fetch("/api/status").then(r=>r.json());

    if(!status.running && !status.paused){
      pauseBtn.disabled = true;
      startBtn.innerText = "Start";
      returnEl.innerText = "End: --:--";
    } else {
      pauseBtn.disabled = false;
      startBtn.innerText = "Reset";
      pauseBtn.innerText = status.paused ? "Resume" : "Pause";

      const endTime = status.paused ? new Date(Date.now() + status.remainingMs) : new Date(status.endTime);
      returnEl.innerText = `End: ${endTime.getHours().toString().padStart(2,"0")}:${endTime.getMinutes().toString().padStart(2,"0")}`;
    }
  }

  progressInterval = setInterval(refreshStatus, 1000);

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
