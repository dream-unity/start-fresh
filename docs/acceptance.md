# Dream Unity: fresh-build acceptance contract

Source: [the original design conversation](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a?ogimg=plain), especially messages 15–38. The latest instruction supersedes that conversation's old integration destination: build in `dream-unity/start-fresh`; leave the existing Dream Unity sites and repositories untouched. This document records the acceptance target, not a claim that every item has passed.

## 1. Scope and meaning

- The implementation lives in `start-fresh`, without deployment, settings changes, writes, or migration against the existing Dream Unity sites or repositories.
- God's Earth View is excluded: no imported application, route, embedded view, navigation destination, provider requirement, or backend dependency for it.
- Dream World remains one of the three conceptual regions. Removing God's Earth View must not remove Dream World.
- The guide understands Dream Machine as possibility and competing models; Dream Maker as agency, attention, meaning, choice, and action; Dream World as encounter, embodiment, other people, constraints, and consequences.
- Unity connects the recurring loop: possibility → experience → meaning → intention → action → consequence → revision → possibility.
- Interpretations remain tentative and revisable. The guide welcomes criticism and contrary evidence; it does not declare literal simulation theory established, claim Dream Unity is the only permissible belief, diagnose the visitor, or present inferred feelings as measurements.

## 2. One continuous Crystal Nexus

- First arrival shows a full-screen living crystalline environment: a central Unity crystal and three distinct, initially distant or dormant regions. The dominant invitation is **SPEAK TO ENTER**.
- The resting experience has no conventional navigation bar, dashboard, portal cards, or rows of navigation buttons. Quiet, discoverable controls for accessibility, privacy, microphone state, and settings are permitted and necessary.
- The central crystal breathes with light. Actual microphone amplitude, when available and permitted, affects its geometry or light and sends feedback along connecting pathways; decorative animation alone is not described as live audio response.
- Dream Machine is blue/cyan and branching; Dream Maker emerald/gold and directional; Dream World violet/crystalline and embodied. They remain related parts of a single scene rather than separate destination pages.
- A conversation can move the camera and change relationships among regions without requiring the visitor to click a portal. The change has a visible start, intermediate movement, and settled destination.
- A synthesis can align the three regions through Unity. This is a visual interpretation of the conversation, not a badge, psychological score, or claim of objective transformation.
- Brief meaningful words may appear within the scene and fade. A complete transcript is available for accessibility and review without becoming the central chat-bubble interface.
- Text entry, readable contrast, keyboard operation, visible focus, reduced motion, and a usable rendering fallback remain available. A visitor is never trapped by denying microphone access.

## 3. Actual dialogue is the navigation mechanism

- After the deliberate entry action, the guide can listen, generate a contextual answer, and speak that answer. Text input participates in the same conversation and affects the same environment.
- The opening invitation is consistent with the brief: **“Tell me why you are here.”** A browser restriction may require an explicit audio-enabling gesture; it must not lead to a false claim that the microphone is already active.
- The guide answers questions about Dream Unity, relates the framework to the visitor's own example, can challenge an assumption respectfully, and can revise an earlier interpretation when corrected.
- Conversation retains enough prior context to resolve a follow-up such as “No, I already know what I want; starting is the problem.” It must not act as an independent keyword classifier for every sentence.
- A real model response produces a validated, bounded scene intention. No model response can execute arbitrary code, invent a URL to visit, overwrite saved notes, or bypass consent.
- The guide can carry the visitor from uncertainty about possibilities toward Dream Machine, from a chosen goal toward Dream Maker, and from an action's real consequences toward Dream World. The visitor can correct the interpretation and return to Unity.
- Unsupported requests receive an honest explanation. The model does not pretend an unimplemented exercise, destination, external action, game, or live data feed exists.
- If inference is unavailable, the app reports that state accurately and preserves available scene, text, transcript, and constellation interactions. It does not substitute canned responses and label them live AI.

## 4. Reliable microphone and speech lifecycle

- Entry requests microphone access only after a user gesture. Listening, thinking, speaking, paused, stopped, unavailable, and error states are distinguishable and truthful.
- Listening begins only after the browser recognizer or microphone confirms it has started. UI state does not repeatedly oscillate because of background availability polling or overlapping starts.
- Normal recognition ending, explicit pause/stop, permission denial, missing input hardware, network failure, and unsupported browser APIs have separate recovery behavior and useful messages.
- Automatic continuation of a deliberately started conversation, if supported, is bounded and canceled immediately by stop, pause, mode change, loss of ownership, or component teardown. Failure does not create an infinite restart loop.
- The app does not transcribe its own speech output as a new user turn. Interrupting speech cancels the relevant utterance and preserves a consistent turn order.
- Late events from an obsolete recognition session or model request cannot restart audio, append duplicate turns, change the active region, or overwrite a newer response.
- Closing or leaving the active session stops microphone tracks, recognition, and speech output. The microphone cannot remain active merely because a UI label changed.
- A visitor can submit typed text when speech recognition is unavailable; dictation support and real AI conversation availability are reported separately.

## 5. A constellation belonging to the visitor

- Goals, insights, contradictions, projects, and possibilities can become distinct nodes with meaningful relationships in the shared environment.
- The app asks before retaining an inferred personal memory. A proposed memory is clearly a proposal and can be rejected or edited; a model inference is not silently promoted to a durable fact.
- A visitor can select **session-only** use without enabling durable storage or creating an account. This mode remains usable when persistent browser storage fails or is blocked.
- Durable saving is an explicit choice. The interface accurately distinguishes session memory from saved memory and states where saving occurs.
- The visitor can inspect, correct, remove, export, and clear retained material. Deleted content cannot be resurrected by a stale inference response or a later normal reload.
- Nodes accumulate through actual interactions and accepted memories. A decorative star field or prepopulated sample nodes do not count as a personal constellation.
- Abandoned or archived possibilities remain recoverable when the visitor chooses to archive rather than delete them. Relationships are visible and editable rather than undisclosed model judgments.
- Only information permitted for the current interaction is included in provider requests. Session-only means no durable storage by this application; it must not falsely promise that a remote provider retains nothing.

## 6. Concrete acceptance journeys

| Journey | Required observable result |
| --- | --- |
| First visit, microphone allowed | Nexus entry gesture activates real audio input; truthful listening state; contextual spoken response; visible scene reaction. |
| First visit, microphone denied | One clear recovery path and quiet text entry; no permission loop, false listening label, or loss of navigation. |
| “I do not know what I want to do with my life.” | Contextual exploration and tentative movement toward Machine; other regions remain part of the scene. |
| Follow-up: “I know what I want. Starting is the problem.” | Guide acknowledges the correction, uses conversation history, and shifts toward Maker. |
| “I tried it. The people I depend on objected.” | Guide engages with consequences and other people, making World relevant without pretending access to real-world data. |
| “I see the possibility, the action, and what reality requires.” | Contextually warranted integration can align the three regions through Unity. |
| “Remember that I want to finish my book.” | Clear proposed goal, explicit retention choice, visible node after acceptance, rejection respected. |
| Session-only constellation, storage unavailable | Nodes work in memory; no claim of permanent saving; current conversation still works. |
| Pause during speech; then resume | No duplicate assistant turn, competing microphone instances, recognition of the app's own voice, or surprise restart after stop. |
| Slow model result after cancel or a new session | Obsolete result is ignored; no delayed speech, movement, or memory write. |
| Reload after durable save; delete and reload | Accepted saved nodes return; deleted nodes stay deleted. Session-only nodes are not falsely reported as saved. |
| Ask for a missing game or external destination | Honest unsupported response; no fabricated implementation and no navigation to God's Earth View. |

## 7. Release evidence and limits

- Record the new repository commit, build result, tested browser/device conditions, and actual inference provider/model used. A source commit alone is not a deployed, usable release.
- Unit tests cover state transitions, stale-event cancellation, scene-intention validation, and consent/storage behavior. Browser tests cover the complete entry → turn → spoken answer → scene transition → accepted memory journey where capabilities are available.
- Mock recognition, mocked speech synthesis, and mocked model output are useful deterministic tests but must be explicitly identified. They do not establish that a real microphone, audible output, or real inference works on the visitor's device.
- At least one real inference smoke test is needed to claim that the AI integration works. Real-device microphone and audible playback verification is separately reported. An inaccessible provider, unfunded account, unsupported device, or missing model download must remain an explicit release limitation.
- Screenshots can establish layout and visible state; they cannot prove an ongoing voice conversation, actual audio capture, or absence of intermittent state oscillation.
- Do not claim the historical **nine games** or **Become** experiences are implemented without their specifications and working destinations. The original discussion proposed intent-driven discovery but did not define those games. An extensible destination registry is not equivalent to shipping them.
- A browser speech recognizer plus text-to-speech is voice transport, not conversational intelligence. A deterministic routing demo is not the requested full portal. An attractive static nexus is not semantic navigation. Test counts cannot replace these distinctions.
