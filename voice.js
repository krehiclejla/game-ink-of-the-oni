// Game voice lines. Games ask for a line with studio.say(); the studio speaks
// it here with either the browser's instant built-in voices or Möbius's
// on-device neural voice (higher quality, needs a voice downloaded once in
// Möbius Voice). Character presets change pitch and speed.

export const VOICE_PRESETS = {
  narrator: { pitch: 1, rate: 1 },
  hero: { pitch: 1.15, rate: 1.05 },
  villain: { pitch: 0.72, rate: 0.9 },
  robot: { pitch: 0.6, rate: 1.05 },
  kid: { pitch: 1.45, rate: 1.1 },
  giant: { pitch: 0.55, rate: 0.85 },
  heroine: { pitch: 1.3, rate: 1.05 },
  old: { pitch: 0.8, rate: 0.85 },
  fairy: { pitch: 1.7, rate: 1.15 },
}

const MOBIUS_SAMPLE_RATE = 24_000

function preset(options = {}) {
  const base = VOICE_PRESETS[options.voice] || VOICE_PRESETS.narrator
  const clamp = (value, lo, hi, fallback) => (Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : fallback)
  return {
    pitch: clamp(options.pitch, 0.5, 2, base.pitch),
    rate: clamp(options.rate, 0.5, 2, base.rate),
  }
}

function pickBrowserVoice(lang) {
  const voices = window.speechSynthesis?.getVoices?.() || []
  const wanted = (lang || navigator.language || 'en').toLowerCase().slice(0, 2)
  return voices.find((v) => v.lang?.toLowerCase().startsWith(wanted) && v.localService)
    || voices.find((v) => v.lang?.toLowerCase().startsWith(wanted))
    || voices[0]
    || null
}

export function browserVoiceAvailable() {
  return typeof window.speechSynthesis?.speak === 'function'
}

export function createVoice() {
  let mode = 'browser'
  let current = null
  let audio = null

  function stop() {
    current?.cancel()
    current = null
  }

  function speakBrowser(text, options) {
    return new Promise((resolve, reject) => {
      if (!browserVoiceAvailable()) return reject(new Error('This browser has no built-in voices.'))
      const { pitch, rate } = preset(options)
      const utterance = new SpeechSynthesisUtterance(text)
      const voice = pickBrowserVoice(options.lang)
      if (voice) utterance.voice = voice
      utterance.pitch = pitch
      utterance.rate = rate
      utterance.onend = () => resolve()
      utterance.onerror = (event) => (event.error === 'interrupted' || event.error === 'canceled' ? resolve() : reject(new Error(event.error || 'Speech failed.')))
      window.speechSynthesis.speak(utterance)
      current = { cancel: () => window.speechSynthesis.cancel() }
    })
  }

  function speakMobius(text, options) {
    const caps = window.mobius?.capabilities
    if (!caps?.available?.('media.speech', 1)) return Promise.reject(new Error('Möbius voice is not available here.'))
    const { pitch, rate } = preset(options)
    audio ||= new AudioContext()
    audio.resume?.()
    const session = caps.open('media.speech', { operation: 'synthesize', text })
    let playhead = audio.currentTime + 0.05
    let lastSource = null
    session.on('audio', ({ samples }) => {
      if (!samples?.length) return
      const buffer = audio.createBuffer(1, samples.length, MOBIUS_SAMPLE_RATE)
      buffer.getChannelData(0).set(samples)
      const source = audio.createBufferSource()
      source.buffer = buffer
      // One knob for character: higher pitch also speaks a little faster.
      source.playbackRate.value = pitch * Math.sqrt(rate)
      source.connect(audio.destination)
      playhead = Math.max(playhead, audio.currentTime)
      source.start(playhead)
      playhead += buffer.duration / source.playbackRate.value
      lastSource = source
    })
    current = { cancel: () => { session.cancel?.(); try { lastSource?.stop() } catch {} } }
    return session.result.then(() => new Promise((resolve) => {
      const wait = Math.max(0, (playhead - audio.currentTime) * 1000)
      setTimeout(resolve, wait)
    }))
  }

  return {
    get mode() { return mode },
    setMode(next) { mode = next === 'mobius' ? 'mobius' : 'browser' },
    stop,
    // Speaks one line, replacing whatever is being said. Falls back to the
    // browser voice when the Möbius voice is not ready on this device.
    async say(text, options = {}) {
      const line = String(text || '').trim().slice(0, 400)
      if (!line) return
      stop()
      if (mode === 'mobius') {
        try {
          return await speakMobius(line, options)
        } catch (error) {
          if (error?.name === 'AbortError') return
          if (!browserVoiceAvailable()) throw error
        }
      }
      return speakBrowser(line, options)
    },
  }
}
