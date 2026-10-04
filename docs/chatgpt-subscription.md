# Why visitors do not sign into ChatGPT

The intended product is an **anonymous public Dream Unity website**. A visitor opens it, speaks or types, and interacts with the site's AI guide. Requiring every visitor to run a local application or authorize their own ChatGPT subscription was the wrong product flow and has been removed from the public interface.

## Personal plan usage versus a public service

OpenAI's [Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart) describes people authorizing their own eligible ChatGPT plans for participating apps. The [open-source overview](https://developers.openai.com/siwc/token-sharing-open-source) binds issued registrations to the authenticated user and workspace and directs remotely hosted app operators to a separate participation path.

A [self-hosted VM](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) can run a protected session for the same user/workspace. That documentation does not establish that one owner's personal Pro subscription can serve arbitrary anonymous website visitors. No such supported entitlement has been verified for this project. We therefore do not promise that connecting GitHub to a ChatGPT account supplies anonymous public inference.

The local OAuth code remains for developer compatibility and historical tests. It is not the public deployment plan, and it is not offered to visitors as a workaround.

## The corrected connection

The website calls its own `/api/nexus` backend. The backend uses the owner's Vercel deployment identity with AI Gateway, which routes conversation requests to `openai/gpt-4.1-mini` and recordings to `openai/whisper-1`. The owner's Gateway allowance or billing funds these requests. **Visitors need no subscription, registration, download or credentials.**

This route does not use the owner's personal ChatGPT Pro allowance and does not copy ChatGPT browser sessions, cookies, access tokens or private history. The guide receives Dream Unity's instructions, the active conversation and approved constellation notes supplied by this application.

The microphone records a bounded turn, transcription supplies text, GPT supplies a structured reply and scene interpretation, and the browser speaks the answer. It is not an embedded ChatGPT Voice session. Provider access and browser hardware still require live checks.

## Owner-only setup still outstanding

The implementation is ready for the owner deployment steps in [README.md](../README.md), but the public service has not been verified live:

- Vercel's connected deployment tool could not access `dream-unity/start-fresh` (`repo_no_access`); the GitHub installation must be granted that repository access. The CLI was not signed in.
- The observed AI Gateway balance was $0. An advertised $5 offer required new card verification and was not activated. Its availability for the selected models has not been established.
- A successful public deployment, completed real chat and real audio transcription remain to be demonstrated.

The owner must configure project spending controls and confirm usable allowance before opening public inference. This is an owner hosting/account task, not a visitor onboarding requirement. No unlimited-free or subscription-funded public service is claimed.

Documentation scope checked against the official OpenAI pages on 4 October 2026. Keep the distinction between a supported personal integration, hosted provider access and a verified anonymous public release explicit.
