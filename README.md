# Dream Unity · Start Fresh

A new implementation of the [original Crystal Nexus brief](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a). This repository is independent of the existing Dream Unity websites.

One continuous crystalline space connects **Dream Machine** (possibility), **Dream Maker** (agency) and **Dream World** (encounter and consequences), through **Unity**. A real conversational model answers your words and proposes movement through the space using constrained structured output. The transcript stays at the edge. Personal threads enter your constellation only when you keep them.

## Run with your ChatGPT subscription

The primary conversation option is **Continue with ChatGPT**. Eligible ChatGPT Plus and Pro accounts can authorize this locally running personal app to use their plan allowance. You do not need to create an API key, buy API credits, or download a language model. Your account, workspace and app usage limits still apply. This uses OpenAI's [official Sign in with ChatGPT flow](https://developers.openai.com/siwc/token-sharing-open-source), documented for local apps in the [September 28 integration guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

Install Node.js 22 or newer, then run:

```sh
git clone https://github.com/dream-unity/start-fresh.git
cd start-fresh
npm start
```

The launcher opens your browser. You can also [download the repository ZIP](https://github.com/dream-unity/start-fresh/archive/refs/heads/main.zip), extract it, and run `Start-Dream-Unity.cmd` on Windows or `Start-Dream-Unity.command` on macOS after installing Node.js. If your computer blocks the launcher, use the terminal command above. No `npm install` is needed. Keep the terminal window open while using the app.

1. Open **http://127.0.0.1:4173** and choose **Speak to enter**.
2. Choose **Continue with ChatGPT**. In the OpenAI window, select your account and approve ChatGPT plan usage for Dream Unity.
3. Return to the app, choose a model offered for that account, and confirm the connection.
4. Choose **Speak to enter** to begin, or write in the quiet text field.

The model picker comes from your signed-in account's current catalog; this app does not assume that every subscription includes a particular model. **Manage usage** opens your ChatGPT usage controls. You can disconnect the account in the app and manage app access in ChatGPT settings. See OpenAI's [model and inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

Sign-in does not import your ChatGPT conversations. Dream Unity supplies its own framework, the current conversation, and the constellation notes you explicitly keep as context. Recognition and spoken replies use browser speech services; this is not ChatGPT's native voice mode. The current subscription integration supports text inference, not audio input or transcription endpoints ([preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).

## Preview and hosting

The [public visual preview](https://dream-unity.github.io/start-fresh/) shows the independent Nexus. To use your ChatGPT subscription, run the repository on your computer as above: the local server handles sign-in and keeps OAuth credentials outside the page. The static GitHub Pages preview cannot perform that server role.

Offering ChatGPT plan usage through a remotely hosted public app requires separate OpenAI access approval. Publishing the preview does not grant that approval or complete a hosted subscription deployment. OpenAI describes the distinction in its [open-source integration guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt).

## Advanced alternatives

Browser and Ollama models remain optional alternatives. They do not use your ChatGPT subscription.

| Runtime | What it needs | Where conversation text goes |
| --- | --- | --- |
| Browser model | A WebGPU-compatible browser/device, about 1 GB initial model download and roughly 2 GB available graphics memory | Inference runs on your device in a worker. Model files come from public distribution hosts. |
| Local Ollama | [Ollama](https://ollama.com), running on the same computer as this server | To the loopback Ollama process. This app does not send it to a cloud AI provider. |

For the local option, install the model before connecting:

```sh
ollama pull qwen2.5:1.5b
npm start
```

If Ollama is not already serving, run `ollama serve` in another terminal. Choose **Connect local model** under the alternative runtimes. To use another installed instruction model, set `OLLAMA_MODEL` when starting the server. These small-model fallbacks can misunderstand intentions: the latest real 1.5B-model smoke test did not consistently choose the requested region. They are not verified substitutes for the primary GPT experience. None of these options requires a Vercel account or external database.

## Enter the experience

After the model is ready, **Speak to enter** starts the opening invitation, “Tell me why you are here.” The guide listens for a turn, answers, speaks, and then offers the next listening turn. A silence, permission error, service failure, explicit pause or backgrounded page pauses the conversation; it cannot start an endless retry loop. A quiet text field uses the same model and scene.

Try:

- “I do not know what I want to do with my life.”
- “Actually, I know what I want. Starting is the problem.”
- “I tried it, but the people I depend on objected.”
- “How do possibility, action and consequence fit together?”

The guide can propose a region and a memory. Region names are validated against a fixed allowlist; the model cannot execute code, open arbitrary destinations, or save your notes. Invalid navigation leaves the scene unchanged. You can explicitly write or say **“go to Dream Machine”**, **“return to Unity”**, **“show my constellation”**, or **“pause”**.

## Your constellation

The default is **session only**. Notes stay in application memory, including when browser storage is unavailable. You can edit, connect, archive, recover, delete, import and export threads. Remembering on this device requires an explicit setting. A future visit offers **Restore my saved constellation**; saved notes are not silently loaded into a new conversation. Turning device saving off removes this app’s saved copy and keeps the current notes in the session. Browser storage is not encrypted; use session mode on a shared device.

Conversation transcripts are held only in the current page and can be exported. Confirmed, active constellation notes can be supplied to the selected model as context. The application stores no audio recordings. Browser speech recognition may use the browser vendor’s network service; local language-model inference does **not** make browser speech recognition offline. Browser support and permission policies vary. Text remains available when recognition is absent.

## Build and verify

```sh
npm test
npm run build
```

`dist/` contains the independent static application. It can be served from an HTTPS host under a repository subpath. Browser inference is available on compatible devices; ChatGPT sign-in and the Ollama option require the included local server. Opening `index.html` directly with `file://` is not supported.

The GitHub Actions workflow runs unit/security tests, a Chromium end-to-end suite with **simulated speech and model responses**. A separate **real Ollama inference** smoke test is available through the manual workflow’s `verify_ollama` option, because Ollama is now an experimental alternative. A passing mocked browser test proves application behavior, not model quality or a successful account authorization. The Ollama semantic limitation above remains a real failure, not a passing inference result. A live ChatGPT authorization and completed response must be verified with an eligible user's consent. Browser-model GPU execution and a physical microphone also need checks on a compatible device.

Results and screenshots are retained as workflow artifacts; the `verification-evidence` branch carries readable evidence tied to the source commit. See the [verification record](docs/verification.md), [acceptance criteria](docs/acceptance.md), [architecture](docs/architecture.md) and [runtime details](docs/model-runtime.md).

The original conversation mentioned historical games and Become without defining their implementation. This build does not claim to ship those unknown experiences. There is no Earth-view application, map embed, or connection to an existing Dream Unity deployment.

## Technical boundaries

The server listens on `127.0.0.1`. It handles the approved OpenAI sign-in/inference endpoints or loopback Ollama, rejects cross-origin chat requests, bounds request size, and serves public app assets separately from credentials. Keep it local; it is not a public multi-user backend. This repository has no service worker or availability polling that can leave an old deployment controlling the interface.

Three.js 0.185.1 is vendored with its MIT licence. WebLLM is pinned to 0.2.85. Model weights retain their respective upstream licences. The small local models can misunderstand an intention; their movement is an interpretation you can correct, never a diagnosis or measured state of mind.
