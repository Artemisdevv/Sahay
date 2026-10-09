<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## App architecture
- Use TanStack file-based routes for role workspaces; preserve the supplied URLs with parameterized route files.
- Keep all emergency dispatch, responder actions, and orchestration telemetry explicitly simulated; no UI action contacts real emergency services.
- Persist medical profiles only through authenticated owner-scoped Cloud rows; demo profile edits remain in memory to avoid storing sensitive data on shared devices.
- Keep consent-aware structured payload generation in a pure shared module so it is testable independently of the UI.
- Render geographic response zones with Google Maps Embed only on authorized credential-free origins; avoid Maps requests in sandbox verification.
