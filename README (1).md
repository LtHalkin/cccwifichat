# LAN Chat

A messenger for everyone on the same WiFi network — no internet, no Bluetooth pairing, no accounts.

## How it works

One device runs a small server. Everyone else on the same WiFi opens a URL in Chrome (or any browser) and joins. Messages broadcast instantly to everyone connected, over the local network.

## Setup

1. Install [Node.js](https://nodejs.org) (v16+) on the device that will host — your laptop is a good choice.
2. Unzip this folder, open a terminal in it, and run:
   ```
   npm install
   node server.js
   ```
3. You'll see something like:
   ```
   On this device:  http://localhost:3000
   On other devices on the same WiFi:
     http://192.168.1.42:3000
   ```
4. Open that second link (your local IP) in Chrome on any phone/laptop connected to the **same WiFi network**. Everyone types a name and joins.

## Notes

- The hosting device needs to stay on and running `node server.js` for the chat to stay up — it's acting as the local server.
- Works on any browser (Chrome, Safari, Firefox) since it's just WebSockets over your WiFi — no Web Bluetooth restrictions.
- If a phone can't reach the IP, check that both devices are on the same WiFi network (not one on WiFi and one on mobile data) and that the host's firewall isn't blocking port 3000.
- To change the port: `PORT=4000 node server.js`.
- Messages aren't stored anywhere — closing the server clears the chat.

## Deploying instead of running locally

If you'd rather not run a server on your own laptop, this same `server.js` + `public/` folder can be deployed to any Node host (Render, Railway, Fly.io, etc.) with a free tier. Then everyone just visits that URL instead of a local IP — works over the internet too, not just local WiFi.
