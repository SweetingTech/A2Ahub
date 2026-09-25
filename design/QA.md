# Visual and interaction verification

Reference: `concept.png`, 1536 × 1024. Both reference and final IAB screenshot were inspected using `view_image`. Browser path: Codex in-app browser, no external fallback. IAB screenshots appear softened, so DOM measurements supplement small text inspection.

| Area       | Comparison and resolution                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout     | Three columns and anchored composer preserved. Native 1536 × 1024 widths adjusted to 330 / flexible / 350; no horizontal overflow.                                     |
| Palette    | White chat canvas, cool gray rails, orange actions, dark headings matched. No added background images or gradients.                                                    |
| Typography | Increased desktop heading, body, and control sizes after first comparison. Deliberately compact at smaller widths.                                                     |
| Composer   | Recipient chips, multiline input, relay toggle, turn limit, Send match the concept. Toggle off and Send disabled in empty state intentionally reflect actual behavior. |
| Icons      | Consistent code-native Lucide line icons; simplified outline brand mark and removal of fictional operating-system window dots are intentional deviations.              |
| Copy       | Brand, headings, explanation, suggestions, footer preserved. Added functional connection controls, streaming capability and expandable integration explanation.        |
| History    | Extra real integration-test room retained; no fabricated message activity.                                                                                             |
| Responsive | Checked 390 × 844. Menu and agent inspector drawers keep connection controls accessible. Composer wraps without clipping.                                              |

Above-the-fold primary copy was preserved. Functional additions are documented above. The implementation was faithfully verified against the concept's layout, palette, hierarchy, spacing, controls and text, with these intentional differences. No material unresolved clipping or layout mismatch remained in tested viewports.

Browser interaction evidence:

- Live send to LilDSweetz showed working then “A2Ahub connected”, completed status, and disabled Stop.
- New room and reload retained history.
- Connect dialog focused endpoint input; unreachable endpoint rendered an error.
- Connection recheck returned connected. Mobile menu → agent opened inspector; close worked.
- Suggestion populated input. Relay toggle enabled turn limit; one-recipient relay was rejected before any agent call.
- Final browser console had no app warnings/errors; production build passed.

Automated tests separately verified successful registration, two mock-agent relay, reply cap, cancellation, recipient validation, legacy format and server-restart persistence. Only one real agent was available; a live two-agent relay has not been tested.

## Concurrent group chat update (2026-09-25)

The earlier screenshots and interaction evidence above describe the original sequential version. They are not visual verification of this update.

Changes: persistent room membership; concurrent agent replies; an always-usable composer during replies; peer-message delivery; Continue, Stop agents, and Resume agents controls; visible reply allowance; wrapped controls for narrow screens.

Verification: `npm test` passed all 16 mock/protocol/integration tests, `npm run build` passed, and `git diff --check` passed. Coverage includes overlapping workers, human interjections, per-agent context ordering, six-request caps, Continue, all-agent cancellation, late replies, offline and input-required agents, timeouts, membership boundaries, missed peer-message catch-up, legacy workspace migration, persistence, and both supported A2A wire formats.

An initial cloud-browser attempt was blocked with `net::ERR_BLOCKED_BY_CLIENT`. Subsequent local verification on 2026-09-25 used bundled Playwright with Edge because the Browser plugin was unavailable. The production app ran at `http://127.0.0.1:4320` with disposable data and two delayed mock A2A agents. Existing app and Hermes processes were left running; the temporary test servers were stopped after verification.

- Desktop (1536 × 1024) and mobile (390 × 844) screenshots were inspected. The three-column desktop layout and mobile composer/control wrapping remained intact, with no horizontal overflow on mobile. Evidence was kept outside the repository.
- Both agents began replying concurrently. The composer remained usable, human interjections were queued per agent, and each completed discussion stayed within six requests.
- Continue started a new bounded discussion. Stop from a second tab paused the room, cancelled both known mock tasks, and cleared queued messages. Resume alone started no requests.
- Reload preserved membership. Mobile menu, agent inspector, connection recheck, and inspector close worked.
- Failed discovery displayed an error. It also exposed a keyboard bug: disabling the submit button could leave focus on the document body, preventing the dialog's original Escape handler from receiving the key. Document-level Escape handling and Tab focus recovery fixed it; both were verified in the browser.
- Page identity and meaningful content were verified, with no framework error overlay or JavaScript runtime errors. Console entries were limited to a missing `/favicon.ico` (404) and the expected invalid-endpoint `/api/agents` response (400).
- All 16 automated tests and the production build passed after the keyboard fix; `git diff --check` passed.

Live endpoint discovery confirmed LilDSweetz advertised A2A 1.0 streaming. Automatic approval review blocked the subsequent live smoke-test command, so no live model request was sent. Concurrent discussion with multiple live model agents remains unverified. The earlier single-agent verification is separate from this mock-based group-chat coverage.
