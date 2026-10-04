# Verification record

## ChatGPT subscription implementation — 4 October 2026

- Local unit, authentication, HTTP, streaming, voice, controller, navigation and memory suite: **165 tests passed** including the final initial-sign-in cancellation regressions.
- Static build and JavaScript syntax checks passed.
- OpenAI’s live OIDC discovery document returned HTTP 200. Its issuer, authorization, token, JWKS and revocation endpoints match the implemented protocol. This was a public metadata read, not an account sign-in.
- Chromium acceptance [passed for the subscription revision `856fd2f`](https://github.com/dream-unity/start-fresh/actions/runs/37178305707) and runs against each published source revision. OAuth, speech recognition, speech synthesis and GPT replies are explicitly simulated there. The real browser still renders the WebGL scene and exercises complete interaction flows. Results and screenshots are in GitHub Actions and the revision-specific `verification-evidence` branch.

## Checks requiring an authorized account or user hardware

A real ChatGPT account has **not** been authorized in this build session. A completed real GPT inference, live plan eligibility, microphone recognition and audible playback are therefore **not yet verified**. To perform that check, run the app locally, complete **Continue with ChatGPT**, choose a model, and have a spoken turn followed by a correction and a paused turn. Check that the reply finishes, the scene follows the intention, and Pause leaves the microphone stopped.

Browser-model WebGPU inference also requires compatible hardware. It is a separate experimental option.

## Preserved fallback evidence

The real Ollama `qwen2.5:1.5b` check at revision `4baf123ab24c20463d2a9569937969cc8cb48d33` produced valid structured JSON but selected World for a possibility-oriented case expected to select Machine. That is a **failed semantic check**, not a verified replacement for GPT. The strict test remains available with `npm run test:inference` or the manual workflow’s `verify_ollama` option; it is no longer part of every push for the primary subscription connection.

## Scope

All source changes and publishing in this work are confined to `dream-unity/start-fresh`. Its GitHub Pages URL is a static preview. It does not provide a remote ChatGPT subscription backend. No existing Dream Unity production deployment was changed.
