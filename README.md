# anthropic-openai-proxy

Fastify proxy agnostico che traduce **Anthropic Messages API** in **OpenAI Chat Completions API**.

Permette di usare client compatibili Anthropic con qualsiasi provider OpenAI-compatible: OpenAI, NVIDIA NIM, OpenRouter, ecc.

## Funzionalità

- Traduction messaggi, system, tool use / tool result
- Streaming SSE coerente con Anthropic
- Retry con backoff su errori 429/5xx
- Logging richieste e dump errori opzionale
- Configurazione via env, nessun hard-code

## Avvio rapido

```bash
cp .env.example .env
# edita .env con le tue credenziali
npm start
```

Server in ascolto su `http://localhost:8080`

## Variabili ambiente

- `PROVIDER_BASE_URL` base URL del provider OpenAI-compatible
- `API_KEY` chiave del provider
- `MODEL` modello da usare
- `DUMP_DIR` cartella per dump richieste fallite
- `PORT` porta server

## Endpoint

- `POST /v1/messages` Anthropic Messages → provider OpenAI
- `GET /api/hello` health check

## Sicurezza

Non committare `.env`. Chiavi e dump sono ignorati via `.gitignore`.

## Licenza

MIT
