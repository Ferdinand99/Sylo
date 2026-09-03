# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report it privately: go to the repository's
**[Security tab](https://github.com/Ferdinand99/Sylo/security)** and click
**"Report a vulnerability"** (this opens GitHub's
[private vulnerability reporting](https://github.com/Ferdinand99/Sylo/security/advisories/new)
form — only you and the maintainers can see it). If you can't use that, contact
the maintainer through their [GitHub profile](https://github.com/Ferdinand99).

Please include:

- what the issue is and where (file / route / command),
- how to reproduce it,
- the impact you think it has.

You'll get an acknowledgement within a few days. Once a fix is ready it ships in
the next release and the advisory is published with credit, unless you ask to
stay anonymous.

## Scope

This policy covers the code in this repository and the instances the maintainer
operates (**Sylo** and **Sylo - Test**). Self-hosted instances are the
responsibility of their own operators.

Out of scope: findings that require a malicious server administrator (they
already have full control of their own server's Sylo data by design), and issues
in third-party services Sylo talks to (Discord, `gametools.network`, Cloudflare
Turnstile).

## Supported versions

Only the latest released version is supported. Run the current image tag
(`iwgamin/sylo:latest` or a pinned `:X.Y.Z`).
