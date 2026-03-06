import { render } from "preact";

import { App } from "./App";
import "./styles.css";
import type { AudioOutputDevice } from "./types";

window.__tfRadioListAudioOutputs = async (): Promise<AudioOutputDevice[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === "audiooutput")
    .map((device, index) => {
      const label = device.label || `Audio Output ${index + 1}`;
      const lower = label.toLowerCase();

      return {
        deviceId: device.deviceId,
        label,
        isDefault: device.deviceId === "default",
        isLikelyVirtualCable:
          lower.includes("cable") || lower.includes("vb-audio") || lower.includes("virtual")
      };
    });
};

const root = document.getElementById("app");
if (!root) {
  throw new Error("Renderer root #app was not found.");
}

render(<App />, root);