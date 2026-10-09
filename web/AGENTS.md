## App architecture
- Use TanStack file-based routes for role workspaces; preserve the supplied URLs with parameterized route files.
- Keep all emergency dispatch, responder actions, and orchestration telemetry explicitly simulated; no UI action contacts real emergency services.
- Persist medical profiles only through authenticated owner-scoped Cloud rows; demo profile edits remain in memory to avoid storing sensitive data on shared devices.
- Keep consent-aware structured payload generation in a pure shared module so it is testable independently of the UI.
- Render geographic response zones with Google Maps Embed only on authorized credential-free origins; avoid Maps requests in sandbox verification.
