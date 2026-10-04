# Public conversation runtime

The primary runtime serves **anonymous website visitors** through an owner-configured backend. Visitors do not select a runtime, sign in, buy a subscription, download model weights, or supply an API key. The server uses the site's Vercel deployment identity with AI Gateway. This is separate from the owner's personal ChatGPT Pro subscription.

## Public contract

The frontend uses `PUBLIC_API_BASE` from `src/runtime-config.js`. Empty means the site's own origin. For a GitHub Pages frontend, set it only after a real backend is deployed and verified; a URL in this file is public configuration, never a credential.

| Operation | Request | Result |
| --- | --- | --- |
| Configuration | `GET /api/nexus?op=status` | Reports whether a deployment identity is configured. It does not perform inference or prove available allowance. |
| Conversation | `POST /api/nexus?op=chat`, JSON with `messages` and optional bounded `context` | A completed, validated `{reply, region, focus, memory}` answer. |
| Transcription | `POST /api/nexus?op=transcribe`, raw audio with its supported Content-Type | `{text}` for the recording, or a recoverable error. |

The API requires an allowed browser Origin for POST requests. The default Pages origin is `https://dream-unity.github.io`; same-origin calls are accepted and `NEXUS_ALLOWED_ORIGINS` can add approved exact origins. This is browser isolation, not identity verification. No visitor token is accepted as an upstream credential.

## Conversation generation

`server/public-model.mjs` selects **`openai/gpt-4.1-mini`** by default at Gateway's Chat Completions endpoint. An owner can change `NEXUS_PUBLIC_MODEL` to another supported OpenAI model, subject to new capability and semantic tests. Visitors cannot change the upstream URL or model.

The server owns the canonical Dream Unity prompt. It bounds history, validates approved-note context, and prevents browser-supplied system messages from replacing the prompt. Notes are treated as untrusted context, not privileged instructions. The prompt grounds dialogue in Machine, Maker, World, Unity, tentative interpretation and practical action; it does not assert that the model measures a person's mind.

Generation is constrained by the shared `RESPONSE_SCHEMA`, with a 700-token maximum, no provider storage requested, and a bounded completed response. The server rejects refusals, truncated answers, unexpected tool calls, invalid JSON and invalid schema. A valid schema establishes an interface contract, not semantic correctness.

The frontend validates the response again, exposes the reply for text and speech, and translates the bounded navigation fields for the scene. Regions are `machine`, `maker`, `world` and `unity`. A memory is nullable or a bounded proposal containing `kind` and `text`. Proposals never save automatically. Generated content is rendered as text, never executable HTML.

The public route uses a complete response rather than streaming partially validated text. Requests have cancellation and timeouts. An interrupted or failed response must not move the scene or resume a cancelled voice turn. There is no automatic retry loop or silent billing/provider fallback.

## Voice capture and playback

The browser records through MediaRecorder where supported. Capture can finish after silence, through **Send recording**, or at its 45-second maximum. Pause, cancellation and a hidden page stop recording and release microphone tracks. Short voice input is bounded to 2 MB by the backend.

`server/public-audio.mjs` forwards supported recordings to Gateway's transcription route using **`openai/whisper-1`**. Text is bounded and validated before joining the conversation. Empty transcription is silence, not a generated answer. The application does not persist the recording. A transcription failure leaves typed input available.

Speech synthesis uses a browser/device voice after a complete reply. This is not an embedded native ChatGPT Voice session or audio-to-audio Realtime integration. Device support, microphone permission, audible output and useful silence thresholds need live testing on desktop and mobile devices.

## Owner configuration and release limits

`@vercel/oidc` obtains a fresh deployment identity on the server. The owner must enable the deployed project's OIDC/Gateway access and establish usable credits or billing. The status operation checks identity configuration only; a zero balance can still cause the first actual inference to fail.

The function bounds request sizes, active work and request frequency. These counters are per instance and are not a global financial cap. Owner project budgets and spending controls must provide aggregate spending protection. Hosting charges and provider eligibility are account-dependent. The current $5 offer observed in the dashboard was not activated; no universal free model allowance is claimed.

At this revision, repository access and Gateway credit verification remain release blockers. A deployed endpoint, real anonymous GPT conversation and real transcription have not yet been verified. See [verification.md](verification.md).

## Retained developer adapters

Local ChatGPT OAuth, WebLLM 0.2.85 and Ollama adapters remain in source for compatibility and historical tests. They are not exposed as public visitor setup. OAuth authorization uses the signing-in person's account; it is not proof that one personal Pro plan may sponsor anonymous visitors. The browser/local Qwen2.5 1.5B fallback failed a recorded semantic region-choice test and is not a verified equivalent to the public GPT route.

## References

- [AI Gateway documentation](https://vercel.com/docs/ai-gateway)
- [Vercel OIDC documentation](https://vercel.com/docs/oidc)
- [OpenAI Sign in with ChatGPT scope](https://developers.openai.com/siwc/token-sharing-open-source)
- [OpenAI per-user integration quickstart](https://developers.openai.com/siwc/quickstart)

Implementation checks and live account availability are distinct. A documented endpoint or passing mock does not establish successful production access.
