# anthropic-openai-proxy

Fastify proxy that translates **Anthropic Messages API** to **OpenAI Chat Completions API**.

It allows Anthropic-compatible clients to work with any OpenAI-compatible provider: OpenAI, NVIDIA NIM, OpenRouter, etc.

## Features

- Message, system prompt and tool use / tool result translation
- Streaming SSE compatible with Anthropic
- Retry with backoff on 429/5xx errors
- Optional request logging and error dumps
- Full configuration via environment variables, no hard-coded secrets

## Quick start

```bash
cp .env.example .env
# edit .env with your credentials
npm start
```

Server listens on `http://localhost:8080`

## Environment variables

- `PROVIDER_BASE_URL` Base URL of the OpenAI-compatible provider
- `API_KEY` Provider API key
- `MODEL` Model to use
- `DUMP_DIR` Directory for failed request dumps
- `PORT` Server port

## Endpoints

- `POST /v1/messages` Anthropic Messages → OpenAI provider
- `GET /api/hello` Health check

## Security

Do not commit `.env`. Keys and dumps are ignored via `.gitignore`.

## License

MIT
