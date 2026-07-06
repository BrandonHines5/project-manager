// Minimal Web Speech API surface. TypeScript's dom lib doesn't ship these
// declarations (the API is still vendor-prefixed in WebKit), so we declare
// just what our dictation UIs use. Shared by the global AI dialog and the
// onsite walkthrough recorder so there's a single source of truth for the
// window augmentation.
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  onresult:
    | ((event: {
        results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>
      }) => void)
    | null
  onend: (() => void) | null
  onerror: ((event: { error?: string }) => void) | null
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
}

/**
 * The recognizer constructor, or null when the browser doesn't support the
 * Web Speech API. Call only in the browser (never during SSR) — typically
 * inside an event handler, since that's the first moment support matters.
 */
export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}
