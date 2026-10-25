# Evening reminder Worker

`push-worker.js` sends the 7 pm "it's not too late to log" notification. It runs free on
Cloudflare Workers. It stores only a random ID per phone, the phone's push address, and the
last day that phone said "logged today ✓". No foods, numbers, emails or names.
It makes its own keys the first time it runs, so there's nothing secret to paste anywhere.

## One-time setup (about 10 minutes, Cloudflare dashboard)

1. **Sign up** at dash.cloudflare.com (the free plan is enough).
2. **Make the Worker:** Workers & Pages → Create → Worker. Name it `opmacro-push` → Deploy.
3. **Paste the code:** Edit code → delete what's there → paste all of `push-worker.js` → Deploy.
4. **Give it storage:** Storage & Databases → KV → Create a namespace called `opmacro-push`.
   Then open the Worker → Settings → Bindings → Add → KV namespace.
   Variable name: `SUBS` (capitals), namespace: `opmacro-push` → Save/Deploy.
5. **Schedule it:** Worker → Settings → Trigger events (Cron Triggers) → Add two:
   - `0 23 * * *` (7 pm Rhode Island time in summer)
   - `0 0 * * *`  (7 pm Rhode Island time in winter)

   The Worker checks the New York hour itself, so only one of them sends each day.
6. **Send the Worker's address** (looks like `https://opmacro-push.YOURNAME.workers.dev`) so it
   goes into `config.js` as `pushUrl`. The address isn't a secret.
   Quick check: opening `https://opmacro-push.YOURNAME.workers.dev/key` in a browser should show `{"key":"..."}`.

## Each person, on their phone

1. iPhone: the app must be on the Home Screen (Share → Add to Home Screen) and opened from there. Needs iOS 16.4+.
2. Settings → 📲 Evening reminder → Turn on → Allow.
3. Tap **Send a test** to see one right away.

## How it decides who gets one

- When the phone logs its first food of the day, it tells the Worker "logged today ✓".
- At 7 pm the Worker sends a reminder to every phone that hasn't checked in today.
- The notification text (quote of the day, log streak) is put together on the phone itself,
  from what the app last saved, so the Worker never sees it.
- Turning it off, or deleting the app, removes the phone from the list.
