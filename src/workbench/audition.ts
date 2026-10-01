import { audioContext } from "../redaction/live-audio";

/** Plain playback of the *unredacted* source, for A/B comparison against the live redacted audio. */
let playing: AudioBufferSourceNode | null = null;
const decodedCache = new Map<string, Promise<AudioBuffer>>();

export function decodeSource(src: string): Promise<AudioBuffer> {
  let p = decodedCache.get(src);
  if (!p) {
    p = fetch(src)
      .then((r) => r.arrayBuffer())
      .then((b) => audioContext().decodeAudioData(b));
    decodedCache.set(src, p);
  }
  return p;
}

export function clipOriginal(src: AudioBuffer, from: number, to: number): AudioBuffer {
  const sr = src.sampleRate;
  const a = Math.max(0, Math.round(from * sr));
  const b = Math.min(src.length, Math.round(to * sr));
  const out = new AudioBuffer({ numberOfChannels: src.numberOfChannels, length: Math.max(1, b - a), sampleRate: sr });
  for (let c = 0; c < src.numberOfChannels; c++) out.copyToChannel(src.getChannelData(c).subarray(a, b), c);
  return out;
}

export function stopOriginal() {
  try {
    playing?.stop();
  } catch {
    /* already stopped */
  }
  playing = null;
}

export async function playOriginal(buf: AudioBuffer): Promise<void> {
  stopOriginal();
  const c = audioContext();
  await c.resume();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  playing = src;
  const done = new Promise<void>((res) => {
    src.onended = () => res();
  });
  src.start();
  return done;
}
