---
target: client/src/screens/Inbox.tsx
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
target_identity: "file:C:\\Users\\HP\\Downloads\\realtydesk-crm\\realtydesk-crm\\client\\src\\screens\\Inbox.tsx"
target_fingerprint: "sha256:c5491514ca1ab412481d5d3b88c6f2205c7bea791447e9488d213ad38d431670"
target_path: "C:\\Users\\HP\\Downloads\\realtydesk-crm\\realtydesk-crm\\client\\src\\screens\\Inbox.tsx"
timestamp: 2026-11-22T20-44-09Z
slug: client-src-screens-inbox-tsx
---
# Design Director Review: Assessment A & B Combined
Target: client/src/screens/Inbox.tsx & client/src/styles.css
System: RealtyDesk CRM (Real Estate Brokerage & Agent Live Telegram CRM)
Surface Mode: Operate

## Design Health Score
| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Hardcoded green "Live" pulse masks disconnects; no message retry indicator; native alert() halts UI |
| 2 | Match System / Real World | 2 | Heavy engineering jargon ("MTProto", "Live Dialogs"); real estate domain context is hidden |
| 3 | User Control and Freedom | 2 | Unsent draft destroyed on chat switch; Load Entire Chat unbounded without pause/cancel |
| 4 | Consistency and Standards | 2 | Floating quick-reply popups, modal card for templates, side drawer for notes, native browser alerts |
| 5 | Error Prevention | 1 | Unsent drafts destroyed on chat change; Block button sits unconfirmed right next to Archive |
| 6 | Recognition Rather Than Recall | 2 | Lead budget, criteria, and property context hidden in drawer; icon buttons lack visible labels |
| 7 | Flexibility and Efficiency | 2 | Templates exist but lack keyboard shortcuts; no arrow-key navigation between conversations |
| 8 | Aesthetic and Minimalist Design | 2 | Side-tab slop warning on blocked rows, bounce easing on cards, over-saturated gradient layers |
| 9 | Error Recovery | 2 | Raw backend exception strings; no inline retry for failed messages |
| 10 | Help and Documentation | 1 | Zero onboarding hints, no explanation of "Repeated" lead filters or MTProto sync |
| **Total** | | **18/40** | **Poor / Major UX Overhaul Needed** |

## Design Specificity Verdict
The interface currently behaves 80% like a generic Telegram Web client clone and only 20% like a specialized real estate brokerage CRM. Core real estate intelligence (property of interest, MLS#, pre-approval status, deal stage) is hidden away in a secondary drawer rather than integrated into the primary conversation triage flow.

## Priority Issues
- [P0] Catastrophic Unsaved Draft Loss on Chat Navigation (/impeccable harden)
- [P1] Accidental Lead Blocking via Exposed, Unconfirmed Header Action (/impeccable polish)
- [P1] Zero Responsive Design (Fixed 340px Desktop Grid) (/impeccable adapt)
- [P2] Deceptive "Live" Status Indicator Masks Connection Failures (/impeccable clarify)
- [P2] CRM Amnesia: Property & Lead Dossier Hidden in Drawer (/impeccable shape)
