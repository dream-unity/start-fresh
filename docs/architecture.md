# Dream Unity — implementation architecture

This independent application implements the conversational Crystal Nexus described in the [original design conversation](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a?ogimg=plain). The current destination is `dream-unity/start-fresh`. It does not import or update the existing production application. Dream World is a conceptual region; God's Earth View is excluded.

## Runtime boundaries

| Component | Responsibility |
| --- | --- |
| `index.html`, `style.css` | Full-screen scene, central invitation, quiet text alternative, accessible dialogs and controls. |
| `src/app.js` | Owns the current conversation, turn cancellation, visible state, scene changes, and explicit memory acceptance. |
| `src/voice.js` | Owns one browser recognition turn or spoken reply at a time; reports capability and permission failures. |
| `src/model.js` | Uses the signed-in ChatGPT plan through the local server, or an explicitly chosen experimental WebLLM/Ollama fallback; bounds context and streams text. |
| `src/meaning.js` | Validates model-proposed navigation and memory data; removes the control channel from visible speech. |
| `src/scene.js` | Draws one continuous Three.js environment, camera movement, regional geometry, and personal constellation nodes. |
| `src/memory.js` | Manages consent, session/device storage, linked notes, archive/recovery, and validated import/export. |
| `server.mjs` | Serves the project on loopback, handles protected ChatGPT OAuth and Responses, and offers an optional local Ollama proxy. |
| `scripts/build.mjs` | Produces a static `dist` directory with a release revision manifest. |

## A conversational turn

1. The visitor selects Continue with ChatGPT and authorizes their eligible plan through OpenAI. An account-specific live model catalog supplies the model picker. Sign-in opens separately to preserve session notes and conversation. Experimental browser/local alternatives require an explicit choice; microphone support and model availability are separate.
2. A deliberate entry action begins the experience. The fixed opening is “Tell me why you are here.” It is an invitation, not a generated answer.
3. A recognised utterance or typed message joins the same session conversation. A bounded recent history and a bounded selection of active, approved constellation notes become model context.
4. All runtimes constrain generation to a shared JSON schema containing the reply, region, focus and optional memory proposal. The adapter exposes only the reply while streaming, validates the completed JSON, and produces the internal `<navigation>` marker. The application validates that bounded intent again and displays only the spoken text.
5. A valid region changes the camera and emphasis within the same scene. Blue/cyan Machine holds possibility; emerald Maker holds agency; violet World holds encounter and consequences; Unity connects them.
6. Browser speech synthesis can speak the reply. A deliberately started voice conversation continues only after successful completion, while it still owns the turn and no blocking dialog is open. Pause, errors, hidden-page transitions, and cancellation prevent stale continuation.
7. A memory suggestion appears as a proposal. It becomes a constellation note only after the visitor opens the editor and explicitly keeps it.

Explicit navigation commands such as “go to Dream Machine” also work without a loaded model. They are user commands, not simulated AI replies. If a model is unavailable, the application preserves available exploration and note-taking while reporting the limitation.

## Memory and privacy

The default is **session-only constellation memory**, with no durable transcript storage by this application. A separate ChatGPT account grant enables model use, but does not load ChatGPT history or turn on constellation saving. A previous saved constellation is not parsed or exposed on construction. Restoring it or enabling “Remember my constellation on this device” is an explicit action that merges saved and current notes before writing.

Switching an active remembered constellation back to session-only removes its saved device copy while retaining current notes in memory. A fresh session does not delete older, unopened saved notes. Clearing operates on the active constellation. If device storage fails, current notes remain usable and exportable in memory; the interface receives a persistent warning when an older device copy may still exist.

Notes have stable IDs, a kind, region, text, creation/update times, explicit links, and an `archived` flag. The visitor can edit, link, archive, recover, delete, export, and import them. Archiving preserves content and relationships but excludes the note from the active scene and future note context. Deletion removes inbound links. It does not rewrite earlier dialogue in the session transcript.

The version-1 JSON format accepts older version-1 entries without an archive flag as active notes. Validation is transactional and bounded: 250 notes, 2,000 characters per stored note, 50 links per note, and a 1 MB document. The note editor offers a shorter 600-character input. Invalid imports leave the current constellation unchanged. Device saves are plain browser storage, not encrypted storage; another person using that browser profile can access them.

## Model and voice limits

The primary connection uses eligible ChatGPT-plan OAuth for a personal/local open-source app. Protected tokens remain outside the repository and browser, in the local account store. The server validates the issued registration, signed identity, granted scope, current account model, and completed Responses stream. Disconnect cancels in-flight requests. No API-key fallback or automatic billing switch exists. A public static page cannot run this local connection; remotely hosted subscription integrations require OpenAI approval. See [chatgpt-subscription.md](chatgpt-subscription.md).

Browser inference uses the pinned WebLLM runtime and a Qwen2.5 1.5B model; model downloads require network access, compatible WebGPU hardware, and substantial device memory. Local inference requires the project server and an installed Ollama model on the same computer. A static hosted copy does not provide the local server. Neither option silently switches to a paid model API. See [model-runtime.md](model-runtime.md) for exact versions, upstream references, resource estimates, and protocol details.

Speech recognition may use the browser vendor's network service. Local text inference therefore does not imply local-only microphone processing. Recognition, speech synthesis, and WebGPU availability are separate browser capabilities. Unsupported speech leaves typed conversation available. The small language model may misunderstand the framework, miss a navigation marker, or offer a poor interpretation; its output is a revisable suggestion, not a psychological measurement.

The scene receives listening and speaking state for visual feedback. State-driven illumination is not evidence that the scene has measured microphone amplitude. Actual microphone amplitude, audible playback, browser GPU compatibility, and model answer quality require separate live verification.

## Verification boundary

The acceptance target is recorded in [acceptance.md](acceptance.md). Unit and deterministic browser tests can establish application state transitions, cancellation behavior, consent rules, validated navigation, and memory operations. Mock model or speech fixtures do not establish real model inference or working hardware audio. Release evidence must distinguish those fixtures from a real downloaded-model smoke test and a real-device spoken conversation.

The historical nine games and Become destinations have not been specified or implemented here. The guide must not claim to open them or any other unavailable external destination. The application is designed to explore the Dream Unity framework through dialogue, not to establish literal simulation theory or make diagnostic claims.
