const storageKey = "harness.turn-sound.v1";

// Audio stays on this device. Create/resume it during a user gesture so later
// completions can chime even when a different chat or application has focus.
export function createTurnSound() {
  let enabled = true,
    context;
  try {
    enabled = localStorage.getItem(storageKey) !== "false";
  } catch {
    // The preference still works for this visit if storage is unavailable.
  }

  function unlock() {
    try {
      const Audio = window.AudioContext ?? window.webkitAudioContext;
      if (!Audio) return;
      context ??= new Audio();
      if (context.state === "suspended")
        return context.resume().catch(() => {});
    } catch {
      // Missing or blocked audio must never interrupt a chat.
    }
  }

  function chime() {
    if (context?.state !== "running") return;
    try {
      const start = context.currentTime;
      for (const [frequency, offset] of [
        [660, 0],
        [880, 0.12],
      ]) {
        const tone = context.createOscillator(),
          volume = context.createGain(),
          at = start + offset;
        tone.type = "sine";
        tone.frequency.value = frequency;
        volume.gain.setValueAtTime(0, at);
        volume.gain.linearRampToValueAtTime(0.045, at + 0.012);
        volume.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
        tone.connect(volume);
        volume.connect(context.destination);
        tone.onended = () => {
          tone.disconnect();
          volume.disconnect();
        };
        tone.start(at);
        tone.stop(at + 0.19);
      }
    } catch {
      // Browsers may suspend audio when the device sleeps or changes output.
    }
  }

  return {
    isEnabled: () => enabled,
    setEnabled(value) {
      enabled = value;
      if (enabled) unlock();
      try {
        localStorage.setItem(storageKey, String(value));
      } catch {
        // Keep the in-memory preference.
      }
    },
    listen(onChange) {
      const gesture = (event) => {
        if (enabled && event.isTrusted) unlock();
      };
      const changed = (event) => {
        if (event.key !== storageKey && event.key !== null) return;
        enabled = event.key === null || event.newValue !== "false";
        onChange(enabled);
      };
      window.addEventListener("pointerdown", gesture, true);
      window.addEventListener("keydown", gesture, true);
      window.addEventListener("storage", changed);
      return () => {
        window.removeEventListener("pointerdown", gesture, true);
        window.removeEventListener("keydown", gesture, true);
        window.removeEventListener("storage", changed);
        context?.close().catch(() => {});
        context = undefined;
      };
    },
    completed(event) {
      if (
        enabled &&
        event.type === "run" &&
        event.runId &&
        event.payload?.status === "completed"
      )
        chime();
    },
    async preview() {
      await unlock();
      chime();
    },
  };
}
