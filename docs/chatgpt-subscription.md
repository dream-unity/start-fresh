# Use your ChatGPT plan in Dream Unity

Dream Unity can use **Sign in with ChatGPT** to request eligible GPT responses through your existing ChatGPT plan. This is an official OAuth integration for open-source, locally hosted applications. It does not require an OpenAI API key, a partner API key, or a client secret. Eligibility and permitted usage are determined by the account and workspace you authorize. See the official [quickstart](https://developers.openai.com/siwc/quickstart) and [open-source overview](https://developers.openai.com/siwc/token-sharing-open-source).

This connects GPT to the experience described in the [original brief](https://chatgpt.com/share/6ac05873-6728-83ec-a932-66616dcb794a): an ongoing dialogue that interprets your intentions through Machine, Maker, World and Unity, moves through one crystalline environment, and suggests constellation threads for your approval. The guide receives the project instructions and the context supplied by this application. Signing in does not give it your existing ChatGPT conversations or account memories.

The account-selected GPT handles conversational reasoning; a small downloaded model is no longer required for this route. That directly matches the request to use your GPT plan and removes local model-download and graphics-memory requirements. Response quality and navigation still need verification with real conversations; no model's interpretation is treated as a measurement of your mind.

## Start the local application

After cloning or downloading this repository, install Node.js 22 or newer. From the `start-fresh` directory, run:

```sh
node server.mjs
```

Open **http://127.0.0.1:4173** on that same computer and choose **Continue with ChatGPT**. Complete OpenAI's account-selection and consent screens, return to Dream Unity, and choose an available GPT model. Then use **Speak to enter**, or write your first intention.

The local process serves the interface and bridges authorized requests to OpenAI. Keep it running while using the experience. You do not need Ollama, a model download, a Vercel account, or an API key for this connection.

OpenAI's consent screen is the account authorization step. Being signed into ChatGPT elsewhere—or approving development in a conversation—does not itself grant this application permission to use your plan. Passwords and verification codes belong only in OpenAI's own sign-in flow. Never paste passwords, browser cookies, access tokens, or refresh tokens into the repository or a support conversation.

## How voice works

| Stage | Component |
| --- | --- |
| Your spoken words become text | Your browser's speech-recognition service |
| A contextual answer and proposed movement are generated | An available GPT, using authorized ChatGPT-plan Responses requests |
| The reply becomes audible | Your browser's speech-synthesis voice |
| The environment moves and a thread may be proposed | Dream Unity's validated scene and constellation logic |

The current [Sign in with ChatGPT preview](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) does not support audio/video input or the transcription API on this route. This implementation therefore sends **text** to GPT. It does not claim to reproduce native ChatGPT Voice, its voices, or an audio-to-audio Realtime session. Browser recognition can depend on a browser vendor's network service and microphone permission; writing remains available if recognition fails.

Only one listening turn runs at a time. Listening ends before a reply is spoken. Pause, backgrounding, permission failures and empty recognition end the turn without a microphone retry loop. A successful spoken reply can lead to the next conversational listening turn while the voice session remains enabled.

## Plan usage and model availability

Eligible requests count toward your authorized ChatGPT plan usage and any applicable app limits or credits settings. This integration does not purchase credits or silently switch to API-key billing. Review the active account and **Manage usage** in ChatGPT settings when a limit is reported. A limit for one app does not prove your entire plan is exhausted. See the official [usage guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) and [error recovery guide](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).

Available models come from the signed-in account's model catalog; a model name is not an entitlement guarantee. Requests use the public Responses endpoint, streaming enabled and storage disabled. The application sends the required conversation context on each request and accepts a reply as finished only after the terminal completion event. A partial stream or late usage error must not be presented as a completed response. See [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).

## Why the public static page needs the local application

The GitHub Pages version can render the Nexus, provide browser-model inference on compatible devices, and manage session-only notes. It does not run the Node process or hold a protected OAuth session. Opening that public page does not start a server on your computer, and this build does not silently forward its account credentials across origins.

Use the local application's own URL for the ChatGPT connection. OpenAI's documented open-source sign-in flow requires an HTTP callback on **127.0.0.1**; `localhost` is not interchangeable in the authorization redirect. The callback reaches the computer running your browser. See [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

A separately hosted, multi-user version needs its own supported hosting and authorization design. The open-source documentation directs paid or remotely hosted app operators to a separate participation path. This repository's local connection does not represent approval for a public hosted integration, and no partner registration or paid service has been purchased for it.

## Credentials and consent

The bridge's credential boundary is the local runtime, not the page's browser storage. OAuth uses fresh state, nonce and PKCE values, validates the signed identity and granted scopes, and retains a stable opaque host identifier. Each account registration must keep its client ID and tokens together. Signing in without the plan-use scope must not enable inference.

Access, refresh and ID tokens must stay out of browser storage, Git, build artifacts, logs and exported conversations. Protected credential files belong outside the served repository, with owner-only access. Refreshes must be serialized and replacement tokens saved together. Signing out stops requests, attempts session revocation, and clears local credentials; if remote revocation cannot be confirmed, the application must say so. You can also disconnect the app in ChatGPT settings. These requirements follow [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).

The repository's automated tests use simulated OAuth and streamed responses. They do not authorize a real account, establish eligibility for your account, or prove real microphone performance. A complete live check requires your own successful consent, a completed GPT reply, audible browser output, and a controlled follow-up turn.

Documentation checked against official OpenAI documentation on 4 October 2026. This capability is a preview; account access and supported requests can change.
