# Warlock Winners

Static site for warlockwinners.com. Edit `index.html`; search for `TODO` to find what needs real info (record, prices, payment links, email).

## Go live (GitHub Pages)
1. Repo Settings → Pages → Source: deploy from branch, pick the branch, folder `/`.
2. At your domain registrar (Google Workspace uses Squarespace Domains), add DNS records:
   - `A` records for `@`: 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153
   - `CNAME` for `www`: `hapakolea.github.io`
   - Keep the existing `MX` records, or Workspace email stops working.
3. Back in Pages settings, tick "Enforce HTTPS" once the certificate is issued.
