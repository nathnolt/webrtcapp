# Running this on your VPS behind Apache

The picture:

```
Browser ──HTTPS/WSS (443)──▶ Apache ──▶ Node (127.0.0.1:3000)   pages + signaling
Browser ──UDP 3478─────────────────────▶ Node                    STUN (Apache can't proxy UDP)
Browser ◀──── video/audio/data goes directly between the two browsers ────▶ Browser
```

Apache only handles the website and the WebSocket. STUN is UDP, so it must be reachable directly on the server. Use a subdomain such as `rtc.example.com` pointing at the VPS.

**Why HTTPS is needed:** browsers only allow camera/mic on HTTPS pages (or localhost). Chat and files work without it, but camera/mic won't.

Commands below are for Debian/Ubuntu. Replace `rtc.example.com` with your domain.

## 1. Put the app on the server

```bash
sudo apt install nodejs npm            # Node 18+ (check: node -v)
sudo mkdir -p /opt/webrtc-demo
# upload server.js, signaling.js, package.json, and index.html + app.js (either in ./public or next to server.js)
cd /opt/webrtc-demo && sudo npm install --omit=dev
sudo chown -R www-data:www-data /opt/webrtc-demo
```

## 2. Keep it running (systemd)

`/etc/systemd/system/webrtc-demo.service`:

```ini
[Unit]
Description=WebRTC demo
After=network.target

[Service]
WorkingDirectory=/opt/webrtc-demo
Environment=PORT=3000
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now webrtc-demo
sudo journalctl -u webrtc-demo -f      # live logs
```

`HOST=127.0.0.1` means that only Apache (on the same machine) can reach Node on port 3000. STUN on UDP 3478 still listens on all interfaces.

## 3. Apache: HTTPS + proxy

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel ssl headers rewrite
```

Make a plain site for the domain, then let certbot add HTTPS:

`/etc/apache2/sites-available/rtc.conf`
```apache
<VirtualHost *:80>
    ServerName rtc.example.com
</VirtualHost>
```
```bash
sudo a2ensite rtc
sudo systemctl reload apache2
sudo apt install certbot python3-certbot-apache
sudo certbot --apache -d rtc.example.com
```

Certbot creates `/etc/apache2/sites-available/rtc-le-ssl.conf`. Open it and add these lines **inside** the `<VirtualHost *:443>` block. Keep the `/ws` lines first:

```apache
    ProxyPreserveHost On
    ProxyPass        /ws  ws://127.0.0.1:3000/ws
    ProxyPassReverse /ws  ws://127.0.0.1:3000/ws
    ProxyPass        /    http://127.0.0.1:3000/
    ProxyPassReverse /    http://127.0.0.1:3000/
```

```bash
sudo apachectl configtest && sudo systemctl reload apache2
```

`ProxyPreserveHost On` matters: the server uses the domain from the request to tell browsers where the STUN server is (`stun:rtc.example.com:3478`).

## 4. Open the firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw allow 3478/udp        # STUN
```
If your VPS provider has its own firewall panel, open the same ports there too. The DNS record for the domain must point straight at the VPS. Don't put it behind a proxy-only service like Cloudflare's orange cloud, because UDP won't pass.

## 5. Try it

Open `https://rtc.example.com` on two devices, use the same room name, and click Join on both. Under *Technical details → ICE candidates* you should see a `srflx` candidate. That means your STUN server worked.

## 6. TURN (strongly recommended for real use)

Direct connections fail between some networks (corporate Wi-Fi, mobile carriers, symmetric NATs). TURN relays the media in those cases. Run coturn **on a different port** than the built-in STUN (3479 here):

```bash
sudo apt install coturn
```

`/etc/turnserver.conf` (replace values):
```
listening-port=3479
realm=rtc.example.com
lt-cred-mech
user=demo:CHANGE_THIS_PASSWORD
min-port=49160
max-port=49200
no-cli
no-multicast-peers
# external-ip=YOUR.VPS.PUBLIC.IP     # only if your VPS is behind NAT (some clouds)
```
```bash
sudo systemctl enable --now coturn
sudo ufw allow 3479/tcp
sudo ufw allow 3479/udp
sudo ufw allow 49160:49200/udp
```

Tell the Node app about it by adding to the `[Service]` section of the systemd file:
```ini
Environment=TURN_URL=turn:rtc.example.com:3479
Environment=TURN_USER=demo
Environment=TURN_PASS=CHANGE_THIS_PASSWORD
```
```bash
sudo systemctl daemon-reload && sudo systemctl restart webrtc-demo
```

Test it: tick **relay only** under *Technical details → ICE servers & policy*, reload the page and connect. The Summary should say "Relayed through a TURN server". (The password is visible to anyone who opens the page. That's fine for a demo. For production, use time-limited credentials.)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Page loads but "WebSocket error" in the State log | `proxy_wstunnel` not enabled, or the `/ws` ProxyPass lines are missing or listed after `/` |
| Camera/mic button says it needs HTTPS | You opened it via `http://` or an IP address; use the HTTPS domain |
| No `srflx` candidates | UDP 3478 blocked (server or provider firewall), or DNS points elsewhere |
| Status "Connection failed" | The Summary's "What to know" line lists the likely causes; usually add TURN |
| Blank page / 404 | Check the first lines of `journalctl -u webrtc-demo`: they say which folder is being served |
