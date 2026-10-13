// S-15: "Send a screenshot" from the widget. Only ever on the visitor's click, through the
// browser's own screen-sharing prompt (getDisplayMedia), so it keeps D-19: nothing is captured
// silently. One frame is grabbed and every track stopped straight away.

/** Longest side of the image we send; very large (e.g. 5K) screens are scaled down. */
const MAX_SIDE = 2560;
/** W-06's upload limit. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Whether this browser can capture the screen here: the API exists (most mobile browsers don't
 * have it) and, inside the widget's cross-origin iframe, the page allowed `display-capture`.
 */
export function canCaptureScreen(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  type Policy = { allowsFeature(feature: string): boolean };
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy };
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  try {
    if (policy && !policy.allowsFeature("display-capture")) return false;
  } catch {
    // unknown feature name in this browser: try anyway
  }
  return true;
}

/**
 * Asks the browser to share a screen, tab or window, grabs one frame and stops sharing.
 * Resolves to a PNG (or JPEG, if the PNG is over 10 MB) or null when the visitor cancels or
 * denies the prompt.
 */
export async function captureScreen(): Promise<File | null> {
  let stream: MediaStream;
  try {
    // preferCurrentTab: Chrome offers "this tab" first, which is what support usually needs.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions);
  } catch (error) {
    const name = (error as DOMException).name;
    if (name === "NotAllowedError" || name === "AbortError") return null; // cancelled or denied: quietly nothing
    throw new Error("Your browser couldn't take a screenshot.");
  }
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // Wait for a real frame (the first one can be 0×0 on some browsers).
    for (let i = 0; i < 50 && (video.videoWidth === 0 || video.videoHeight === 0); i++) await new Promise((r) => setTimeout(r, 20));
    if (video.videoWidth === 0) throw new Error("Your browser couldn't take a screenshot.");
    await new Promise((r) => requestAnimationFrame(r));
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    stop(stream);
    video.srcObject = null;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`; // the visitor's local time
    let blob = await toBlob(canvas, "image/png");
    if (blob.size > MAX_BYTES) blob = await toBlob(canvas, "image/jpeg", 0.85);
    if (blob.size > MAX_BYTES) throw new Error("The screenshot is too large to send.");
    return new File([blob], `Screenshot ${stamp}.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type });
  } finally {
    stop(stream);
  }
}

function stop(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Your browser couldn't take a screenshot."))), type, quality));
}
