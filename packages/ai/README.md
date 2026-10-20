# @runkiln/ai

The LLM layer of RunKiln. It talks to one backend only: **RunInfra**, an OpenAI-compatible API at `https://api.runinfra.ai/v1`.

What's in the package:

- One provider (`runinfra`) using one API implementation (`openai-completions`)
- A `Models` collection for model lookup, auth, and streaming
- Tools with TypeBox schemas and argument validation
- Streaming events for text, thinking, and tool calls, plus usage and cost tracking
- A faux provider for deterministic tests

## Installation

`@runkiln/ai` is a workspace package inside the RunKiln monorepo. Node >= 22.19.0.

## Package entry points

| Import | Contents |
| --- | --- |
| `@runkiln/ai` | Core: types, `createModels`, `createProvider`, auth helpers, credential store, faux provider, utils. No side effects. |
| `@runkiln/ai/providers/runinfra` | `runInfraProvider`, `RUNINFRA_PROVIDER_ID`, `RUNINFRA_DEFAULT_BASE_URL`, `RUNINFRA_API_KEY_ENV` |
| `@runkiln/ai/api/*` | The OpenAI-compatible chat completions implementation |
| `@runkiln/ai/compat` | Global `stream` / `complete` / `streamSimple` / `completeSimple` kept for older coding-agent call sites. Importing it registers the `openai-completions` implementation. |
| `@runkiln/ai/models`, `@runkiln/ai/utils/*` | Direct module access |

## Quick start

```typescript
import { createModels, Type, type Context, type Model, type Tool } from '@runkiln/ai';
import { runInfraProvider, RUNINFRA_PROVIDER_ID } from '@runkiln/ai/providers/runinfra';

// RunKiln builds its chat models from models.yaml. Their baseUrl is overwritten by the provider.
declare const runInfraModels: Model<'openai-completions'>[];

const models = createModels();
models.setProvider(runInfraProvider({ models: runInfraModels }));

const model = models.getModel(RUNINFRA_PROVIDER_ID, runInfraModels[0].id)!;

const tools: Tool[] = [{
  name: 'get_time',
  description: 'Get the current time',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: 'IANA timezone, e.g. Europe/Paris' }))
  })
}];

const context: Context = {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'What time is it?', timestamp: Date.now() }],
  tools
};

const s = models.stream(model, context);
for await (const event of s) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'toolcall_end':
      console.log(`\nTool called: ${event.toolCall.name}`, event.toolCall.arguments);
      break;
    case 'done':
      console.log(`\nFinished: ${event.reason}`);
      break;
    case 'error':
      console.error(`Error: ${event.error.errorMessage}`);
      break;
  }
}

const message = await s.result();
context.messages.push(message);

for (const call of message.content.filter((b) => b.type === 'toolCall')) {
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: new Date().toISOString() }],
    isError: false,
    timestamp: Date.now()
  });
}

// Non-streaming
const reply = await models.complete(model, context);
console.log(`Tokens: ${reply.usage.input} in, ${reply.usage.output} out, cost $${reply.usage.cost.total.toFixed(4)}`);
```

Other events emitted by the stream: `start`, `text_start`, `text_end`, `thinking_start`, `thinking_end`, `toolcall_start`, `toolcall_delta`.

## The RunInfra provider

```typescript
runInfraProvider({
  models,      // Model<'openai-completions'>[], required
  baseUrl,     // optional, defaults to RUNINFRA_DEFAULT_BASE_URL (https://api.runinfra.ai/v1)
  apiKey,      // optional key from the local user config
});
```

Every model is rewritten to `provider: 'runinfra'` and the provider's `baseUrl`. A model's `reasoningEffort` (from `harness_effort` in models.yaml) is sent as `reasoning_effort` on every request.

### Auth

The API key resolves in this order:

1. `RUNINFRA_API_KEY` from the environment
2. `apiKey` passed to `runInfraProvider()` (the local user config)

Stored credentials and other environment variables are never consulted for RunInfra. `RUNINFRA_API_KEY` is the only provider env var the package reads; `getEnvApiKey('runinfra')` and `findEnvKeys('runinfra')` (from `@runkiln/ai/compat`) expose it.

`createModels()` also accepts `credentials` (a `CredentialStore`, e.g. `InMemoryCredentialStore`), `modelsStore`, and `authContext`.

## Models collection

`createModels()` returns a `MutableModels`:

- Lookup: `getProviders()`, `getProvider(id)`, `getModels(provider?)`, `getModel(provider, id)`, `getAllModels(provider?)`, `getAvailable(provider?)`
- Auth: `checkAuth(providerId)`, `getAuth(providerIdOrModel)`
- Generation: `stream`, `complete`, `streamSimple`, `completeSimple`
- Mutation: `setProvider(provider)`, `deleteProvider(id)`, `clearProviders()`

Helpers exported from the root: `createProvider`, `calculateCost`, `getSupportedThinkingLevels`, `clampThinkingLevel`, `modelsAreEqual`, `hasApi`, `isModelType`, `getModelType`.

`stream`/`complete` take the raw OpenAI-completions options (`OpenAICompletionsOptions`). `streamSimple`/`completeSimple` take `SimpleStreamOptions`, including a thinking level (`reasoning`). That level only selects `samplingParamsByThinkingLevel`; a level set to `null` in `thinkingLevelMap` is unsupported and is clamped. The thinking level is not sent as `reasoning_effort`.

## Tools

Tools are defined with TypeBox (`Type` and `Static` are re-exported from `@runkiln/ai`). Tool-call arguments stream incrementally via `toolcall_delta`; the final, parsed arguments arrive on `toolcall_end`. Validation helpers live in `utils/validation` and are re-exported from the root.

## Stop reasons

`AssistantMessage.stopReason` is one of `stop`, `length`, `toolUse`, `error`, `aborted`, `pending`, `deferred`. On `error` or `aborted`, `errorMessage` explains why.

## Aborting

Pass an `AbortSignal` as `signal` in the stream options. An aborted request ends with `stopReason: 'aborted'`; the partial message can be pushed back into the context and the conversation continued.

## Faux provider for tests

`fauxProvider()` builds an in-memory provider with scripted responses:

```typescript
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@runkiln/ai';

const faux = fauxProvider({ tokensPerSecond: 50 }); // optional pacing
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

faux.setResponses([
  fauxAssistantMessage([fauxThinking('Check first.'), fauxToolCall('echo', { text: 'hi' })], { stopReason: 'toolUse' }),
  fauxAssistantMessage([fauxText('Done.')])
]);

const first = await models.complete(model, {
  messages: [{ role: 'user', content: 'Call echo', timestamp: Date.now() }]
});

console.log(faux.getPendingResponseCount(), faux.state.callCount);
```

- Responses are consumed in request order. An empty queue returns an error message: `No more faux responses queued`.
- `setResponses` replaces the queue, `appendResponses` adds to it. A step can also be a function `(context, options, state, model) => AssistantMessage | Promise<AssistantMessage>`.
- `fauxProvider({ provider, models: [{ id, reasoning }] })` creates several faux models.
- Usage is estimated at about 1 token per 4 characters.
- For the global `@runkiln/ai/compat` API, use `registerFauxProvider()`, and call `unregister()` when done.

## Global compat API

```typescript
import { complete, stream } from '@runkiln/ai/compat';
```

`stream`, `complete`, `streamSimple`, and `completeSimple` dispatch on `model.api` to a registered implementation. If no `apiKey` is given, `RUNINFRA_API_KEY` is used for `runinfra` models. New code should use `createModels()`.

## License

MIT. See [LICENSE](LICENSE).
