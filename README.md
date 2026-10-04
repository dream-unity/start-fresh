# Dream Unity · Start Fresh

An independent implementation of the [original Crystal Nexus brief](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a): one continuous crystalline space connecting **Dream Machine** (possibility), **Dream Maker** (agency), **Dream World** (encounter and consequences), and **Unity**.

The intended public experience is simple: **open the website and speak or type to its AI guide**. Visitors do not create an account, sign into ChatGPT, subscribe, install an application, download a language model, or provide credentials. The site owner supplies the hosted AI connection. Personal threads enter a constellation only when the visitor chooses to keep them.

## Release status — 4 October 2026

The public frontend and owner-funded server implementation are in this repository. **A working public AI release has not yet been verified.** The [GitHub Pages copy](https://dream-unity.github.io/start-fresh/) serves the interface; GitHub Pages itself does not run the conversation or transcription backend.

The new site and Node backend have been deployed directly and claimed into the owner’s Vercel `start-fresh` project. The public address is https://dream-unity-start-fresh.vercel.app. The hosted API currently returns configuration-required, so live AI is not being claimed as working. Remaining owner setup is concrete:

- Vercel's connected deployment tool rejected access to `dream-unity/start-fresh` with `repo_no_access`; its GitHub integration needs access to this repository. The CLI was not signed in.
- The AI Gateway dashboard showed **$0 available**. Its advertised $5 credit required a new card verification and was not activated. No usable free balance or model eligibility has been established.
- The direct deployment exists, but its API reports `PUBLIC_CONFIGURATION_REQUIRED`. Rebuilding under the owner’s enabled deployment identity and verifying real chat/audio remain release gates. The hosting dashboard subsequently stopped responding to automation.

The existing ChatGPT Pro subscription has **not** been established as a way to fund anonymous visitors. This implementation uses the owner's Vercel AI Gateway allowance or billing, separate from ChatGPT subscription usage. It makes no claim of unlimited free inference. See [the connection decision](docs/chatgpt-subscription.md) and [verification record](docs/verification.md).

## How the public conversation works

1. The visitor chooses **Speak to enter** and grants microphone permission, or writes in the text field.
2. The browser records a short turn. Silence can finish it automatically; **Send recording** ends it manually. Recording is capped at 45 seconds.
3. The site's backend sends the recording for transcription and the resulting text for a contextual GPT reply.
4. The reply is spoken with a browser voice. Validated meaning data moves the camera through the same Nexus and may propose a constellation thread.
5. Keeping a proposed thread requires the visitor's explicit choice. Pause, cancellation or leaving the page stops the active microphone turn and invalidates late results.

The server selects `openai/gpt-4.1-mini` for conversation and `openai/whisper-1` for transcription through AI Gateway. These are implementation defaults, not claims of verified account access. This is browser recording and speech synthesis around GPT text reasoning; it is not an embedded ChatGPT Voice session. Writing remains available when microphone capture is unsupported.

Try: “I do not know what I want to do with my life.” Then: “Actually, I know what I want. Starting is the problem.” The guide should revise its interpretation as the conversation changes. Its suggestions are not psychological measurements.

## Owner deployment

These steps are for the site owner. Visitors never perform them.

1. In the existing Vercel **`start-fresh`** project (`prj_QzzDHhnNOQQtQ5BxTucDpV7gB760`), connect the Git repository **`dream-unity/start-fresh`**. If it is missing or returns `repo_no_access`, grant the Vercel GitHub integration access to this repository. The direct-deployment workaround already created this project; do not create a duplicate. Keep existing Dream Unity projects and domains unchanged.
2. Use **Node.js 24**, the repository root, install command **`npm ci`**, build command **`npm run build`**, and output directory **`dist`**. The `api/nexus.mjs` Node function must be deployed alongside the static assets; uploading `dist` alone is insufficient.
3. Enable the project's **OIDC deployment identity** and AI Gateway access. The backend obtains a fresh owner deployment token with `@vercel/oidc`; no visitor credential or public API key is required. Do not copy personal ChatGPT credentials into Vercel or the repository.
4. Check the Gateway account's actual balance and access to both configured models. Complete any owner verification that the dashboard requires. Any advertised trial credit is conditional; do not treat the displayed offer as an activated allowance or a guarantee that all models qualify.
5. Configure the Gateway **project budget and spending controls** before inviting visitors. The code's rate limits are per server instance; they are not a durable global quota or a substitute for owner spending controls. Provider usage, hosting costs and credit eligibility remain account-dependent.
6. Deploy to the new project's HTTPS URL. Confirm `/api/nexus?op=status` returns a configured connection. This check does not generate a billable answer and does not verify available credits; then complete a real anonymous typed conversation and a real recorded voice turn.
7. Verify a correction changes the guide's interpretation, a kept note appears in the constellation, and Pause stops the microphone without later automatic reopening. Test from a signed-out/private browser and a real mobile device.
8. GitHub Pages is configured in `src/runtime-config.js` to use `https://dream-unity-start-fresh.vercel.app`. After the backend is operational, verify this cross-origin path as well. If the host changes, update `PUBLIC_API_BASE` to the **verified backend origin**, rebuild and publish the Pages assets. Do not put tokens in this value. The backend permits `https://dream-unity.github.io`; list any additional approved frontend origins in `NEXUS_ALLOWED_ORIGINS` as comma-separated exact origins. The empty default uses the current site's own `/api/nexus` function.

The deployment defaults are intentionally owner-controlled. `NEXUS_PUBLIC_MODEL` may select another supported OpenAI model in Gateway, but changing it requires new structured-output, semantic and cost checks. No public visitor can choose an arbitrary upstream, model or billing credential.

## Development

Install Node.js 24 and run:

```sh
git clone https://github.com/dream-unity/start-fresh.git
cd start-fresh
npm ci
npm test
npm run build
npm start
```

The local launcher is a development convenience, not a visitor requirement. Serving the interface locally does not create production Gateway access. Use a configured deployment identity and an approved backend when testing real public inference. Opening `index.html` with `file://` is unsupported.

`dist/` contains static assets. `api/nexus.mjs` and its server modules provide the public conversation and transcription function. The app has no service worker or repeating availability check that should flip microphone readiness on and off.

## Constellation and privacy

Constellation memory defaults to **session only**. Notes remain in the page's memory until the visitor explicitly enables remembering on that device. Saved notes require a deliberate restore on a later visit. Visitors can edit, connect, archive, recover, delete, import and export their notes. Turning device saving off removes the application's saved copy and retains the active session. Browser storage is not encrypted.

The conversation and approved notes are sent to the site's AI service as context. Recordings are forwarded for transcription; this application does not persist audio recordings or server-side transcripts. Provider processing and retention policies remain separate. Browser speech synthesis also depends on the device and selected voice. Exporting a transcript or constellation is an explicit visitor action.

## Verification and scope

Automated tests distinguish simulated provider/speech fixtures from real inference. Passing browser tests can establish interaction and cancellation behavior, but cannot prove a working production allowance, audible playback, or physical microphone quality. See [verification](docs/verification.md), [architecture](docs/architecture.md), and [runtime details](docs/model-runtime.md).

Legacy local ChatGPT OAuth, WebLLM and Ollama modules remain for developer compatibility and historical tests. They are not visitor setup options or the primary public architecture. The previous 1.5B Ollama semantic test failed; it is not presented as a verified substitute for GPT.

Work is confined to `dream-unity/start-fresh`. **God's Earth View is excluded.** No existing Dream Unity deployment or domain is part of this release. The historical nine games and Become destinations were not specified sufficiently to implement and are not claimed as shipped. Three.js is vendored with its MIT licence; retained model runtimes and weights have their respective upstream licences.
