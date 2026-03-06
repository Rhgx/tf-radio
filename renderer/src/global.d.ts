import type { AudioOutputDevice, TfRadioApi } from "./types";

declare global {
  interface Window {
    tfRadio: TfRadioApi;
    __tfRadioListAudioOutputs: () => Promise<AudioOutputDevice[]>;
  }
}

export {};