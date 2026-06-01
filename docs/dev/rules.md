# Detection Rules

Detection rules live in `src/rules.ts`. The scanner in `src/scanner.ts` applies these rules to supported open documents.

## Rule Shape

Each rule uses the `SecretRule` type:

```ts
export type SecretRule = {
  id: string;
  name: string;
  severity: "low" | "medium" | "high";
  regex: RegExp;
  message: string;
  valueGroup?: number;
  minimumLength?: number;
};
```

## Rule Fields

| Field | Purpose |
| --- | --- |
| `id` | Stable identifier used by diagnostics and ignore storage. |
| `name` | Human-readable rule name. |
| `severity` | Internal severity used for deduplication and VS Code diagnostic severity. |
| `regex` | Pattern used to find suspicious text. |
| `message` | Diagnostic message shown in VS Code. |
| `valueGroup` | Optional capture group containing only the secret value. |
| `minimumLength` | Optional rule-specific length threshold. |

## Current Rules

| Rule ID | Severity | Detects |
| --- | --- | --- |
| `private-key` | High | Private key headers such as `-----BEGIN PRIVATE KEY-----`. |
| `github-token` | High | Classic GitHub token prefixes such as `ghp_`, `gho_`, `ghu_`, `ghs_`, and `ghr_`. |
| `github-fine-grained-token` | High | Fine-grained GitHub tokens starting with `github_pat_`. |
| `aws-access-key` | High | AWS access key IDs starting with `AKIA` or `ASIA`. |
| `stripe-live-key` | High | Stripe live secret keys starting with `sk_live_`. |
| `database-url` | High | Database URLs containing a username and password. |
| `generic-secret-assignment` | Medium | Quoted assignments to suspicious variable names such as `apiKey`, `password`, `token`, or `client_secret`. |
| `env-secret-assignment` | Medium | Unquoted `.env`-style assignments to suspicious names such as `DATABASE_URL=value`. |

## Diagnostic Severity

Safe Code maps each rule's internal severity to a VS Code diagnostic severity in `src/extension.ts`:

| Rule severity | VS Code diagnostic severity |
| --- | --- |
| `high` | Error |
| `medium` | Warning |
| `low` | Information |

Use `high` for high-confidence or high-impact findings such as private keys, cloud credentials, live payment keys, and database URLs with credentials. Use `medium` for generic secret assignments. Reserve `low` for low-confidence or example-like findings when those rules are added.

## Generic Assignment Detection

The generic assignment rule is built from `secretVariableName` in `src/rules.ts`.

It looks for variable or property names containing terms such as:

- `api_key`
- `apikey`
- `secret`
- `token`
- `password`
- `private_key`
- `client_secret`
- `access_token`
- `refresh_token`
- `database_url`
- `connection_string`

It then requires a `:` or `=` assignment and a quoted value with at least 8 characters.

Example matches:

```ts
const apiKey = "sk_live_123456789abcdef";
const clientSecret = "super-secret-value";
const password = "admin12345";
```

## Environment Assignment Detection

The environment assignment rule catches unquoted `.env`-style values.

Example matches:

```dotenv
DATABASE_URL=postgres://user:pass@example.com/app
API_KEY=abc123456789
export CLIENT_SECRET=super-secret-value
```

## Value Extraction

Some rules match only the secret itself. For those rules, `valueGroup` is not needed.

Assignment rules match a larger expression but only want to underline the assigned value. Those rules set `valueGroup` so the scanner extracts the capture group that contains the secret value.

Example:

```ts
const apiKey = "abc123456789";
```

The rule match is `apiKey = "abc123456789"`, but the diagnostic range points at `abc123456789`.

## Placeholder Filtering

The scanner rejects common placeholder values in `isCommonFakeValue()`.

Ignored exact values include:

- `example`
- `sample`
- `test`
- `fake`
- `dummy`
- `changeme`
- `change-me`
- `your-api-key`
- `your-token`
- `xxx`
- `xxxx`
- `xxxxx`
- `123456`
- `password`

Ignored fragments include:

- `your-api-key`
- `your_api_key`
- `your-token`
- `your_token`
- `replace-me`
- `replace_me`
- `changeme`
- `change-me`

Values made only of `x`, `*`, `.`, `_`, or `-` are also ignored.

## Adding A Rule

1. Add a new object to `secretRules` in `src/rules.ts`.
2. Use a stable `id` because ignore storage depends on it.
3. Use a global regex with the `g` flag so `matchAll()` can find every occurrence.
4. Set `valueGroup` if the diagnostic should underline only part of the full match.
5. Set `severity` according to the centralized diagnostic severity mapping.
6. Keep the pattern specific enough to avoid noisy false positives.
7. Update this document if rule behavior, filtering, or examples change.
8. Run `npm run compile` after changing rules.

## Rule Design Guidelines

- Prefer precise service-specific patterns when possible.
- Avoid warning on normal words like `password` unless there is an assignment and a suspicious value.
- Keep generic rules conservative.
- Add placeholder filters when a rule commonly matches examples or docs.
- Avoid entropy detection until the extension has stronger suppression and severity controls.
