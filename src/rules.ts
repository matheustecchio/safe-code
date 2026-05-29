export type SecretRuleSeverity = "low" | "medium" | "high";

export type SecretRule = {
  id: string;
  name: string;
  severity: SecretRuleSeverity;
  regex: RegExp;
  message: string;
  valueGroup?: number;
  minimumLength?: number;
};

const secretVariableName = String.raw`[A-Za-z0-9_$-]*(?:api[_-]?key|secret|token|password|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|database[_-]?url|connection[_-]?string)[A-Za-z0-9_$-]*`;
const quotedSecretAssignment = new RegExp(
  String.raw`(["'\`]?)${secretVariableName}\1\s*[:=]\s*(["'\`])([^"'\`\r\n]{8,})\2`,
  "gi"
);
const unquotedEnvSecretAssignment = new RegExp(
  String.raw`^\s*(?:export\s+)?${secretVariableName}\s*=\s*([^\s#"'\`][^#\r\n]{7,})`,
  "gim"
);

export const secretRules: SecretRule[] = [
  {
    id: "private-key",
    name: "Private key",
    severity: "high",
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g,
    message: "Private key detected. Do not commit private keys."
  },
  {
    id: "github-token",
    name: "GitHub token",
    severity: "high",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    message: "GitHub token detected. Avoid committing tokens or private credentials."
  },
  {
    id: "github-fine-grained-token",
    name: "GitHub fine-grained token",
    severity: "high",
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    message: "GitHub token detected. Avoid committing tokens or private credentials."
  },
  {
    id: "aws-access-key",
    name: "AWS access key",
    severity: "high",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    message: "AWS access key detected. Avoid committing cloud credentials."
  },
  {
    id: "stripe-live-key",
    name: "Stripe live secret key",
    severity: "high",
    regex: /\bsk_live_[A-Za-z0-9]{12,}\b/g,
    message: "Stripe live secret key detected. Avoid committing payment credentials."
  },
  {
    id: "database-url",
    name: "Database URL",
    severity: "high",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s"'`]+:[^@\s"'`]+@[^\s"'`]+/gi,
    message: "Database connection string with credentials detected."
  },
  {
    id: "generic-secret-assignment",
    name: "Generic secret assignment",
    severity: "medium",
    regex: quotedSecretAssignment,
    valueGroup: 3,
    message: "Possible hardcoded secret detected. Avoid committing tokens, API keys, passwords, or private credentials."
  },
  {
    id: "env-secret-assignment",
    name: "Environment secret assignment",
    severity: "medium",
    regex: unquotedEnvSecretAssignment,
    valueGroup: 1,
    message: "Possible hardcoded secret detected. Avoid committing tokens, API keys, passwords, or private credentials."
  }
];
