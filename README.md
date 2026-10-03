# gcoysorg
Gcoys.org Repository
Website for the Georgia Council of Youth Sports (GCoYS).

## How publishing works

This repository is connected to the Cloudflare Worker `gcoysorg`.
Any change saved (committed) to `index.html` on the `main` branch goes live automatically in about a minute at https://gcoysorg.mrjasonmbrown.workers.dev

- `index.html` is the whole website (images are embedded inside it).
- `wrangler.jsonc` and `.assetsignore` are Cloudflare settings. Do not delete them.
