# Sasa POS: QR sign-in and screen lock

Upgrade for the Sasa Restaurant POS. Same Supabase project, same staff, same data.

## What's new
- **Every staff member gets their own QR card** the moment their login is created. Download it as a PNG or print it. The card shows the logo, name and role.
- **Sign in by typing or by scanning.** The login page has two tabs: Type, and Scan QR card. Scanning uses the camera, or "Scan from a photo" if there is no camera.
- **Screen lock.** If nobody touches the screen for a while, the person is signed out (with a 15 second warning first) and the half-built order is cleared. Default: admin 5 minutes, cashier 2 minutes, chef 15 minutes. Change it under Settings, Screen lock. Enter 0 to switch a role off.
- **Sign-in log.** The Activity screen now shows who signed in, whether by password or QR card, and who was signed out for being idle.
- Closing the browser tab now signs the person out, so a shared till is never left signed in.

## Good to know
- **A QR card is a key.** Anyone holding it can sign in as that person. Hand it over privately, and press **New QR card** if one is lost. The old card stops working straight away. Disabling a staff member blocks both their password and their card.
- **The card is shown once.** Only a scrambled fingerprint of the code is stored, so not even you can look it up later. That is why a lost card is replaced rather than recovered.
- **The camera needs a secure page.** It works on `http://localhost`, `http://127.0.0.1` and any `https://` address. It does not work on a plain `http://192.168...` address. On those, use "Scan from a photo", or host the app on an https address.
- **While someone is signed out they do not get the ready-order alert.** Their orders stay in "My orders" for when they sign back in. If that is too strict for your cashiers, raise their minutes in Settings.
- Typing a username and password still works exactly as before.
