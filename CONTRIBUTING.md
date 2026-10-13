# Contributing

Thanks for your interest. The plan lives in [`docs/`](docs/) (start with `build-plan.md` and `features.md`), and [CLAUDE.md](CLAUDE.md) has the code conventions. Run `npm test`, `npm run typecheck` and the end-to-end suites (see the README) before opening a pull request.

## Contributor License Agreement

We'll ask contributors to sign a CLA before we merge outside pull requests. It lets us offer the project under a commercial license as well as AGPL-3.0 (decision D-14 in `docs/decisions.md`). The CLA bot and agreement text aren't set up yet; until they are, please open an issue before starting a large change.

## Licensing of parts

- Server and dashboard (`worker/`, `web/`, `packages/llm`, `packages/cli`): AGPL-3.0-only.
- Widget loader (`public/widget.js`) and the agent-config format (`AGENTS.md`, `skills/`, `tools/`, `evals/` files and the `jun init` templates): MIT. SDKs, when they exist, will be MIT too.
