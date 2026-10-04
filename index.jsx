// A Game Studio game, installed as its own Möbius app. This file is the same
// for every game; publish_game.py writes the game itself (game.js) and its art
// (data*.js) next to it. Edit the game in Game Studio, not here: publishing
// replaces every file in this folder.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Comment, EditPencil, X } from '@openai/apps-sdk-ui/components/Icon'
import { buildGameDocument, relayVisibility } from './gameRuntime.js'
import { createVoice } from './voice.js'
import { GAME } from './game.js'
import DATA from './data.js'

const CSS = `
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
.gp-root { position: fixed; inset: 0; background: ${GAME.background}; overflow: hidden; }
.gp-bar { position: absolute; inset: 0 0 auto 0; height: calc(var(--mobius-safe-top, 0px) + 60px); padding: var(--mobius-safe-top, 0px) max(12px, var(--mobius-safe-right, 0px)) 0 calc(max(10px, var(--mobius-safe-left, 0px)) + 54px);
  display: flex; align-items: center; gap: 10px; color: #fff; background: rgba(0,0,0,.28); border-bottom: 1px solid rgba(255,255,255,.08); }
.gp-bar h1 { flex: 1; min-width: 0; margin: 0; font: 700 16px/1.2 system-ui, sans-serif; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gp-stage { position: absolute; inset: calc(var(--mobius-safe-top, 0px) + 60px) 0 0 0; }
.gp-stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.gp-edit { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.1); color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
.gp-edit:hover { background: rgba(255,255,255,.18); }
.gp-edit:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gp-edit svg { width: 16px; height: 16px; }
.gp-toast { position: absolute; z-index: 3; left: 50%; bottom: max(16px, var(--mobius-safe-bottom, 0px)); transform: translateX(-50%);
  width: min(92vw, 440px); display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 14px;
  background: rgba(20,22,40,.94); color: #fff; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.4); }
.gp-toast p { margin: 0; flex: 1; }
.gp-toast button { min-height: 40px; padding: 0 12px; border-radius: 10px; border: 0; background: #fff; color: #111; font: 600 13px system-ui, sans-serif; cursor: pointer; }
.gp-note-open { flex: none; display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.22); background: transparent; color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
.gp-note-open:focus-visible, .gp-note button:focus-visible, .gp-note textarea:focus-visible, .gp-note input:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.gp-note-open svg { width: 16px; height: 16px; }
.gp-note-scrim { position: absolute; inset: 0; z-index: 4; display: flex; align-items: flex-end; justify-content: center; background: rgba(0,0,0,.45); }
.gp-note { width: min(100%, 460px); margin: 0 0 max(12px, var(--mobius-safe-bottom, 0px)); padding: 18px; border-radius: 20px; background: #171a2e; color: #fff;
  font: 15px/1.45 system-ui, sans-serif; box-shadow: 0 -8px 40px rgba(0,0,0,.45); display: grid; gap: 12px; }
@media (min-width: 600px) { .gp-note-scrim { align-items: center; } }
.gp-note header { display: flex; align-items: center; justify-content: space-between; }
.gp-note h2 { margin: 0; font-size: 18px; }
.gp-note p { margin: 0; color: rgba(255,255,255,.7); font-size: 14px; }
.gp-note textarea, .gp-note input { width: 100%; padding: 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: #fff; font: inherit; }
.gp-note textarea { min-height: 110px; resize: vertical; }
.gp-note-actions { display: flex; justify-content: flex-end; gap: 8px; }
.gp-note-actions button, .gp-note-close { min-height: 44px; padding: 0 16px; border-radius: 12px; border: 0; font: 600 14px system-ui, sans-serif; cursor: pointer; }
.gp-note-send { background: #fff; color: #111; }
.gp-note-send:disabled { opacity: .5; cursor: default; }
.gp-note-close { width: 44px; padding: 0; display: grid; place-items: center; background: transparent; color: #fff; }
.gp-note-done { text-align: center; padding: 8px 0; }
.gp-loading { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.7); font: 600 15px system-ui, sans-serif; }
`

const store = () => window.mobius?.storage

export default function GameApp({ appId }) {
  const frameRef = useRef(null)
  const savesRef = useRef(null)
  const motionRef = useRef(null)
  const voiceRef = useRef(null)
  voiceRef.current ||= createVoice()
  const [ready, setReady] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [error, setError] = useState(null)
  // A visitor on a public link can't read the game's private saves; the owner can.
  const [visitor, setVisitor] = useState(false)
  const visitorRef = useRef(false)
  visitorRef.current = visitor
  const [noteOpen, setNoteOpen] = useState(false)
  const startedRef = useRef(Date.now())

  // Saves (best score, progress) belong to this app. The owner's first launch
  // starts from whatever the game had saved in the studio. A visitor on a
  // shared link always starts a fresh game: none of the owner's progress, and
  // their own lasts while this page is open (they cannot write the app's saves).
  useEffect(() => {
    let alive = true
    voiceRef.current.setMode(GAME.voiceMode === 'mobius' ? 'mobius' : 'browser')
    store()?.get('saves.json')
      .then((saved) => { savesRef.current = saved || GAME.initialSaves || {} })
      .catch(() => { savesRef.current = {}; if (alive) setVisitor(true) })
      .finally(() => { if (alive) setReady(true) })
    return () => { alive = false }
  }, [])

  // Games want the whole screen.
  useEffect(() => {
    const post = (value) => window.parent.postMessage({ type: 'moebius:immersive', value, appId }, '*')
    post(true)
    return () => post(false)
  }, [appId])

  const srcDoc = useMemo(() => (ready
    ? buildGameDocument(GAME.html, { sprites: DATA.sprites, sounds: DATA.sounds, models: DATA.models, art: DATA.art, saves: savesRef.current })
    : null), [ready, runKey])

  // Leaving the game (the shell keeps it loaded, hidden) silences and freezes it.
  const visibilityRef = useRef(null)
  useEffect(() => {
    const relay = relayVisibility(() => frameRef.current, (visible) => { if (!visible) voiceRef.current?.stop() })
    visibilityRef.current = relay
    return relay.stop
  }, [])

  useEffect(() => {
    const onMessage = (event) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return
      const msg = event.data || {}
      if (msg.type === 'studio:error') {
        setError(String(msg.message || 'Something went wrong'))
      } else if (msg.type === 'studio:save' && typeof msg.key === 'string') {
        savesRef.current = { ...savesRef.current, [msg.key]: msg.value }
        if (!visitorRef.current) store()?.set('saves.json', savesRef.current).catch(() => {})
      } else if (msg.type === 'studio:tilt-start') {
        startTilt()
      } else if (msg.type === 'studio:say') {
        const reply = (err) => frameRef.current?.contentWindow?.postMessage({ type: 'studio:say-done', id: msg.id, error: err }, '*')
        voiceRef.current.say(msg.text, { voice: msg.voice, pitch: msg.pitch, rate: msg.rate, lang: msg.lang })
          .then(() => reply(), (err) => reply(String(err?.message || err)))
      } else if (msg.type === 'studio:say-stop') {
        voiceRef.current.stop()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  function startTilt() {
    const caps = window.mobius?.capabilities
    if (motionRef.current || !caps?.available?.('device.motion', 1)) return
    const session = caps.open('device.motion', { rateHz: 30 })
    motionRef.current = session
    session.on('sample', ({ orientation, screenAngle }) => {
      if (!orientation || orientation.gamma == null) return
      let x = orientation.gamma / 35
      let y = (orientation.beta - 40) / 35
      if (screenAngle === 90) [x, y] = [y, -x]
      else if (screenAngle === 270 || screenAngle === -90) [x, y] = [-y, x]
      frameRef.current?.contentWindow?.postMessage({ type: 'studio:tilt', x, y }, '*')
    })
    const clear = () => { motionRef.current = null }
    session.ready?.catch(clear)
    session.result?.then(clear, clear)
  }
  useEffect(() => () => { motionRef.current?.finish?.(); motionRef.current = null; voiceRef.current?.stop() }, [runKey])

  const restart = () => { setError(null); setRunKey((k) => k + 1) }
  const edit = () => window.parent.postMessage({ type: 'moebius:open-app', appId: GAME.studioAppId, intent: `game:${GAME.id}` }, '*')

  return (
    <div className="gp-root">
      <style>{CSS}</style>
      <header className="gp-bar">
        <h1>{GAME.name}</h1>
        <button type="button" className="gp-note-open" onClick={() => setNoteOpen(true)}><Comment aria-hidden="true" />Note</button>
        {GAME.studioAppId && !visitor && (
          <button type="button" className="gp-edit" onClick={edit} aria-label={`Edit ${GAME.name} in Game Studio`}>
            <EditPencil aria-hidden="true" />Edit
          </button>
        )}
      </header>
      <main className="gp-stage">
        {srcDoc ? (
          <iframe
            key={runKey}
            ref={frameRef}
            title={GAME.name}
            sandbox="allow-scripts allow-pointer-lock"
            allow="fullscreen *; gamepad *; autoplay *"
            srcDoc={srcDoc}
            onLoad={() => { visibilityRef.current?.sync(); frameRef.current?.contentWindow?.focus() }}
          />
        ) : <div className="gp-loading">Loading {GAME.name}…</div>}
      </main>
      {noteOpen && <NoteSheet startedAt={startedRef.current} onClose={() => { setNoteOpen(false); frameRef.current?.contentWindow?.focus() }} />}
      {error && (
        <div className="gp-toast" role="alert">
          <p>The game hit a problem: {error.slice(0, 140)}</p>
          <button type="button" onClick={restart}>Restart</button>
          {GAME.studioAppId && !visitor && <button type="button" onClick={edit}>Fix in studio</button>}
        </div>
      )}
    </div>
  )
}

// A playtest note for the maker. Notes go to the game's private inbox
// (public/notes/), which public visitors may add to but never read; Game Studio
// collects them for the owner.
function NoteSheet({ startedAt, onClose }) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [state, setState] = useState('idle')
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  const send = async (event) => {
    event.preventDefault()
    if (!text.trim()) return
    setState('sending')
    const at = new Date().toISOString()
    const id = `${at.replace(/[^0-9]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await store().set(`public/notes/${id}.json`, {
        text: text.trim().slice(0, 1000), name: name.trim().slice(0, 40) || null, at,
        playedSeconds: Math.round((Date.now() - startedAt) / 1000),
      })
      setState('sent')
    } catch {
      setState('failed')
    }
  }
  return (
    <div className="gp-note-scrim" onClick={onClose}>
      <form className="gp-note" role="dialog" aria-modal="true" aria-labelledby="gp-note-title" onClick={(event) => event.stopPropagation()} onSubmit={send}>
        <header>
          <h2 id="gp-note-title">Note for the maker</h2>
          <button type="button" className="gp-note-close" aria-label="Close" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {state === 'sent' ? (
          <>
            <p className="gp-note-done">Thanks! Your note is on its way.</p>
            <div className="gp-note-actions"><button type="button" className="gp-note-send" onClick={onClose}>Back to the game</button></div>
          </>
        ) : (
          <>
            <p>What was fun, what was confusing, what would you change? Only the game's maker sees this.</p>
            <textarea autoFocus value={text} maxLength={1000} onChange={(event) => setText(event.target.value)} aria-label="Your note" placeholder="The second jump felt too hard…" />
            <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} aria-label="Your name (optional)" placeholder="Your name (optional)" />
            {state === 'failed' && <p role="alert">That didn't send. Check your connection and try again.</p>}
            <div className="gp-note-actions">
              <button type="submit" className="gp-note-send" disabled={!text.trim() || state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Send note'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
