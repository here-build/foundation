# Security Policy

## Supported Versions

| Version | Security Support |
|---------|------------------|
| 0.x     | Best effort - known limitations documented |
| 1.x+    | Full support (planned) |

## Reporting a Vulnerability

**Email**: team@here.build
**Telegram/X**: @merkle_bonsai

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We aim to:
- Acknowledge within 48 hours
- Provide initial assessment within 5 business days
- Coordinate on disclosure timeline (typically 90 days)

## Known Limitations (0.x)

**arrival-scheme**: Sandbox has known architectural issues. Use only in zero-trust environments with container isolation. Assume sandbox can be escaped. External audit planned for 1.x.

See package READMEs for deployment recommendations.
