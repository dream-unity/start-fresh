# Dream Unity — public architecture

This independent Crystal Nexus implements the [original conversational brief](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a?ogimg=plain) in `dream-unity/start-fresh`. Dream World is a conceptual region; God's Earth View and the existing Dream Unity deployments are outside its scope.

## Product boundary

Visitors open the website and speak or type without an account, ChatGPT subscription, application download, or credentials. The owner supplies a separate hosted AI connection and its allowance. Personal ChatGPT Pro usage has not been established as a supported anonymous visitor pool. The retained local OAuth implementation is developer compatibility code, not the public entry flow.

## Runtime boundaries

| Component | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Continuous scene, central invitation, text input, status and accessible constellation controls. |
| `src/app.js` | Conversation ownership, cancellation, visible state, microphone continuation, scene changes and memory acceptance. |
| `src/voice.js` | One recording or spoken reply at a time, silence detection, recording limit, manual send and complete capture cleanup. |
| `src/model.js` | Public API client, bounded conversation context and validated model results; retained legacy adapters are not visitor choices. |
| `src/runtime-config.js` | Public backend origin; empty uses the page's own server. Contains no secrets. |
| `src/response-schema.js`, `src/meaning.js` | Strict response contract and allowlisted movement/memory proposals. |
| `src/scene.js` | Continuous Three.js geometry, camera transitions, regional emphasis and constellation nodes. |
| `src/memory.js` | Consent, session/device notes, links, archive/recovery and validated import/export. |
| `api/nexus.mjs` | Node serverless adapter for `/api/nexus`; propagates disconnects and cancels abandoned requests. |
| `server/public-api.mjs` | Operation dispatch, allowed origins, bounded inputs, timeout, per-instance rate limits and owner identity. |
| `server/public-model.mjs` | Server-owned instructions, GPT request, response bounds and complete structured-output validation. |
| `server/public-audio.mjs` | Bounded recording forwarding and transcription result validation. |
| `scripts/build.mjs` | Static assets in `dist` and a source revision manifest. The API must be deployed separately alongside these assets. |

## A conversational turn

1. A deliberate entry action begins with “Tell me why you are here.” This fixed invitation is not presented as a generated answer. A connection check establishes backend configuration, not paid allowance or successful inference.
2. The browser captures a short microphone turn with MediaRecorder where supported. Silence can end it; manual send ends it immediately; a 45-second limit bounds capture. Typing bypasses recording and transcription.
3. `/api/nexus?op=transcribe` receives the recording and returns text. Audio is passed to the configured provider for that request, not stored by this application.
4. The current utterance joins bounded session history. The frontend sends it with a bounded set of active notes the visitor explicitly kept to `/api/nexus?op=chat`.
5. The server obtains its deployment's Gateway token. Only server configuration chooses the upstream and model. Visitor-supplied system messages cannot replace the canonical instructions.
6. GPT returns `reply`, `region`, `focus` and an optional memory proposal under a constrained JSON schema. Both server and client validate the result. The public route returns a complete validated answer; it does not stream partial unvalidated prose into speech.
7. An allowed region changes the camera in the same environment: Machine is possibility, Maker is agency, World is encounter and consequence, and Unity connects them. Browser speech synthesis speaks the reply.
8. A deliberately active voice conversation may begin its next recording only after the reply completes and the current turn still owns the session. Pause, page hiding, errors and cancellation prevent late results from restarting the microphone.
9. A proposed memory becomes a note only after the visitor explicitly keeps it. A generated proposal cannot save itself.

Explicit navigation commands can work without an AI response. These are direct user commands, not simulated conversational intelligence. When the backend is unavailable, the app reports that limitation while retaining exploration and note-taking.

## Identity, spending and isolation

The public function uses the owner's **Vercel OIDC deployment identity** for AI Gateway. Tokens remain server-side; they are not supplied by visitors, embedded in static assets, or copied from a personal ChatGPT session. The default conversation model is `openai/gpt-4.1-mini`; transcription uses `openai/whisper-1`.

Allowed origins isolate browser callers. They do not authenticate people or defeat non-browser clients that spoof an Origin header. Per-instance concurrency and expiring request counters reduce abuse but are not durable global limits. The owner must configure Gateway project spending controls and review account availability before release. No automatic alternate billing path or provider switch is used.

Provider failures are mapped to safe visitor messages; raw provider bodies, tokens and stack traces are not returned. A configured OIDC token does not prove a positive balance or provider entitlement. Only completed real chat and transcription requests verify those paths.

## Memory and privacy

Constellation memory defaults to **session only**. Account sign-in is not part of the public flow, and keeping a note does not enable device saving. A previous device copy is not silently loaded. Restoring saved notes or enabling remembering is explicit.

Turning remembering off removes the saved device copy while retaining active notes. A fresh session does not delete older, unopened notes. Storage failures preserve in-memory work and export access, with a warning if a prior device copy could not be removed.

Notes have stable IDs, kind, region, text, timestamps, explicit links and an archived flag. Archive preserves content and links while excluding notes from the active scene and future model context. Deletion removes inbound links but does not rewrite earlier session dialogue. Imports are validated transactionally: at most 250 notes, 2,000 characters per stored note, 50 links per note and a 1 MB document. The editor uses a shorter 600-character limit.

The application does not persist recordings or server-side transcripts. Active conversation and approved notes are nevertheless processed by the hosted model; microphone recordings are processed by the transcription provider. Provider policies are separate from application storage. Device storage is plain browser storage, not encryption.

## Verification boundary

Deterministic tests establish cancellation, consent, request validation, provider error handling and interaction behavior with explicit fixtures. They do not prove a live deployment, usable owner credits, real microphone transcription, audible speech or model interpretation quality. See [verification.md](verification.md) for current evidence and release blockers.

Historical games and Become remain unspecified and unimplemented. Model interpretations are revisable suggestions, not diagnosis or proof of a literal simulation theory.
