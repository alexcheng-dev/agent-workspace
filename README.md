# agent-workspace

Public GitHub Actions workspace for short-lived SSH worker runners used by `/Users/igor/Documents/sshworker`.

The workflow starts an Ubuntu runner, exposes SSH through `*.lolgames.net`, uploads the connection details as an artifact, and keeps the runner alive for up to 6 hours.
