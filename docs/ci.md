# Continuous integration in this fork

The regular Android APK build, release-version check, TypeScript checks, unit
tests, unsigned iOS build, and deterministic Maestro activation tests remain
available. Existing event and path filters still apply.

## Optional Sentry source-map uploads

The Android APK workflow disables Sentry source-map uploads by default. An
upstream Sentry project or missing credentials must not prevent building an APK.
This does not remove the Sentry SDK or change runtime crash-reporting consent.

To opt in, configure all three repository secrets with values for a Sentry
project you control:

- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Then set the repository Actions variable `SENTRY_UPLOAD_ENABLED` to `true`.
Uploads remain disabled if any of the three secrets is absent. Once enabled
with all three secrets, upload errors are reported as build failures so an
invalid token or project is not silently ignored. Set the variable to `false`
(or remove it) to return to credential-free APK builds.

Store/F-Droid publishing workflows keep their separate service configuration;
this change does not make publishing credential-free.

## Removed external-service workflows

The following upstream workflows were removed from this fork because their
external services are not configured here:

- Sentry noise-gate reporting (Sentry organization read access and Play data)
- Play Store review triage (Google Play service-account access)
- AI-driven CUA smoke testing (Azure OpenAI endpoint and model credentials)

Their scripts remain available for manual use, and the workflows can be
restored from Git history if those services are configured later. This removes
their automatic scheduled/push runs; it does not disable the deterministic
Maestro activation tests or change GitHub notification settings.

## Informational dependency audit

The security workflow now records `npm audit --json` and `npm audit --omit=dev
--json` results in its summary and uploads both raw reports. This job is
non-blocking while compatible fixes for the Expo 54 dependency graph are being
tracked. An unavailable/malformed audit is reported as an error, never as zero
findings. npm's production graph includes build tooling and does not establish
APK exploitability. See [the dependency audit](security/dependency-audit-2026-10-08.md)
for the measured baseline, applied fixes and remaining risks.

The standard APK, unit-test and F-Droid-flavored APK jobs use `npm ci
--legacy-peer-deps` so verification installs the committed lockfile.

The source-patched F-Droid APK job also runs on pull requests so it can be
verified without publishing a tag. Release publishing remains tag-only.
