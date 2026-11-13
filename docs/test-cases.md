# Sasa POS: Test Cases

Scope: login, roles, order lifecycle, payment, menu, staff, settings, security.
Priority: H = high, M = medium, L = low. Auto = automated in Playwright (file in brackets).
Result column is for your manual runs: Pass / Fail / Blocked, with a bug ID if it fails.

## Test environment
- Use a separate Supabase test project, not the live restaurant data. Run `schema.sql` there and deploy the edge functions.
- Create three test users (one admin, one cashier, one chef) and put them in `.env`.
- Browser: latest Chrome. Add phone and tablet emulation for the responsive checks.

## 1. Login and session

| ID | Title | Priority | Steps | Expected | Auto | Result |
|---|---|---|---|---|---|---|
| TC-001 | Admin signs in | H | Enter admin username and password, press Sign in | Overview screen opens, role pill shows "admin" | Yes (login.spec) | |
| TC-002 | Cashier signs in | H | Same with cashier | "New order" screen opens | Yes (login.spec) | |
| TC-003 | Chef signs in | H | Same with chef | Kitchen screen opens | Yes (login.spec) | |
| TC-004 | Wrong password | H | Valid username, wrong password | Toast "Wrong username or password", stays on login | Yes (login.spec) | |
| TC-005 | Empty form | M | Press Sign in with both fields empty | Browser blocks submit, no request sent | Yes (login.spec) | |
| TC-006 | Username case | L | Enter username in capitals | Sign-in succeeds | Yes (login.spec) | |
| TC-007 | Log out | H | Press Log out | Login screen shown, app hidden | Yes (login.spec) | |
| TC-008 | QR tab toggle | L | Press "Scan QR card" | Scanner panel shown, password form hidden | Yes (login.spec) | |
| TC-009 | Idle timeout warning | H | Set cashier idle to 1 minute, leave screen untouched | Warning dialog with 15 second countdown, then signed out | Later | |
| TC-010 | Stay signed in | M | At the idle warning press "I am still here" | Warning closes, session continues | Later | |
| TC-011 | Session ends with tab | M | Sign in, close tab, reopen site | Login screen shown (session storage cleared) | Manual | |
| TC-012 | Disabled account | H | Admin disables a cashier, cashier tries to sign in | Rejected with "not active" message | Manual | |

## 2. Role restrictions

| ID | Title | Priority | Steps | Expected | Auto | Result |
|---|---|---|---|---|---|---|
| TC-013 | Cashier menu | H | Sign in as cashier | Only "New order" and "My orders" visible | Yes (login.spec) | |
| TC-014 | Chef menu | H | Sign in as chef | Only "Kitchen" visible | Yes (login.spec) | |
| TC-015 | Admin menu | H | Sign in as admin | All seven admin screens visible | Yes (login.spec) | |
| TC-016 | Cashier cannot change menu prices (API) | H | As cashier, call update on menu_items from the browser console | Rejected by security rules, price unchanged | Manual | |

## 3. Order lifecycle

| ID | Title | Priority | Steps | Expected | Auto | Result |
|---|---|---|---|---|---|---|
| TC-017 | Create dine-in order | H | Cashier adds 2 items, Dine-in, table 5, Send to kitchen | Toast with order number, cart cleared, order visible to chef as New | Later | |
| TC-018 | Totals and VAT | H | Add items totalling R100 with VAT on at 15% | Subtotal R100.00, VAT R15.00, Total R115.00 | Later | |
| TC-019 | Delivery needs customer details | M | Choose Delivery, leave customer blank, Send | Error toast, order not created | Later | |
| TC-020 | Empty cart | M | Open New order with nothing added | Send to kitchen is disabled | Later | |
| TC-021 | Quantity limit | M | Press + on one item 51 times | Quantity stops at 50 | Later | |
| TC-022 | Kitchen flow | H | Chef: Start preparing, then Ready | Order moves New, Preparing, Ready for pickup | Later | |
| TC-023 | Ready alert | H | Chef marks cashier's order ready | Cashier sees ready toast and nav badge increases | Manual | |
| TC-024 | Cancel order | M | Cashier cancels a pending order | Status Cancelled, order removed from kitchen | Later | |

## 4. Payment

| ID | Title | Priority | Steps | Expected | Auto | Result |
|---|---|---|---|---|---|---|
| TC-025 | Cash with change | H | Ready order total R115, tender R200 | "Change due R85.00", payment confirms | Later | |
| TC-026 | Cash not enough | H | Tender R100 on R115 order | "Not enough cash", Confirm disabled | Later | |
| TC-027 | Card and EFT | M | Choose Card, confirm | Confirm enabled without tender, order Collected | Later | |
| TC-028 | Receipt | M | After payment press Print receipt | Receipt shows items, VAT, total, payment method | Manual | |

## 5. Admin

| ID | Title | Priority | Steps | Expected | Auto | Result |
|---|---|---|---|---|---|---|
| TC-029 | Create staff with QR card | H | Staff screen, fill form, Create login | Login created, QR card shown once | Manual | |
| TC-030 | Duplicate username | M | Create a second user with an existing username | "That username is already taken" | Manual | |
| TC-031 | Short password | M | Create user with 7 character password | Rejected, minimum 8 characters | Manual | |
| TC-032 | Price change logged | M | Change a menu price, open Activity | Entry "Changed a price" with old and new value | Manual | |
| TC-033 | Report totals | H | Complete 3 paid orders, open Reports for Today | Paid sales equals sum of the 3 totals, VAT collected matches | Manual | |

## Boundary and equivalence notes (for ISTQB practice)
- Quantity: valid 1 to 50. Boundaries to test: 0, 1, 2, 49, 50, 51.
- Cash tendered against total: below total (invalid), exactly equal (valid, change 0), above (valid).
- Password length: 7 (invalid), 8 (valid).
- Username: 2 chars (invalid), 3 (valid), 30 (valid), 31 (invalid).
- Idle minutes in settings: valid 0 to 240, with 0 meaning off. Try -1, 0, 240, 241.
