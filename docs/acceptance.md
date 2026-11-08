<!-- BEGIN e2e -->

Run 2026-11-08T10:54:09.180Z · commit be61372-dirty · Stripe mock (stripe-mock behind the stateful proxy) — mock evidence only · telephony: simulator · LLM: fake

| Check                                                                         | Web                                          | iOS                                          | Android                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Criterion 1 — end-to-end meetup completion                                    | Blocked — Stripe test-mode keys not supplied | Blocked — Stripe test-mode keys not supplied | Blocked — Stripe test-mode keys not supplied |
| Criterion 8 — reachability (no locked meetup needed)                          | pass                                         | Pending — macOS host required                | Pending — Maestro CLI not installed          |
| Criterion 8 — reachability: accept, check-in, messaging, dispute, suggestions | Blocked — Stripe test-mode keys not supplied | Blocked — Stripe test-mode keys not supplied | Blocked — Stripe test-mode keys not supplied |
| WCAG 2.1 AA — axe on core flows                                               | pass                                         | n/a                                          | n/a                                          |
| Web proving                                                                   | fail                                         | n/a                                          | n/a                                          |
| Console clock skew                                                            | pass                                         | n/a                                          | n/a                                          |

<!-- END e2e -->
