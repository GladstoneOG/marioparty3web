# ⭐ Mario Party 3 Web (`marioparty3web`) — 1–4 Player Online N64

- **Live Worker URL**: `https://marioparty3web.johansans999.workers.dev`
- **GitHub Repository**: `https://github.com/GladstoneOG/marioparty3web`

A zero-install browser port of **Mario Party 3 (N64, USA)** running on **Mupen64Plus-Next / ParaLLEl N64 Libretro WebAssembly (WebGL2)** with **1–4 Player Online Multiplayer** powered by **WebRTC P2P DataChannels** and a **CGNAT-proof Cloudflare Workers + SQLite Durable Objects** relay & room browser.

---

## ✨ Features

- **1–4 Player Online Multiplayer (Star-Topology Deterministic Lockstep)**:
  - **Direct WebRTC P2P + Per-Peer CGNAT Fallback**: Each guest automatically upgrades to a low-latency unordered WebRTC `RTCDataChannel` (`stun.cloudflare.com`, zero Durable Object quota). Peers behind strict CGNAT / symmetric NAT seamlessly stay on the Cloudflare Durable Object WebSocket relay with smart 2-frame batching — **zero port forwarding and zero credit card required**.
  - **Hot-Join Savestate Sync & Live Room Browser (`F2`)**: Create a room, copy a 1-click invite link (`?room=STAR42`), or join from the minimalist room browser. Host automatically compresses and streams the live N64 hardware state so players drop right onto the exact same frame.
  - **Native In-Game Menus**: No accounts or heavy overlays — manage boards, minigames, and Human↔COM controller slots directly inside Mario Party 3's menus.
- **Universal WebGL2 Compatibility**: Runs smoothly on any modern desktop browser, including older DX11 / non-WebGPU GPUs (default `Mupen64Plus-Next`, with `ParaLLEl N64` available in the drawer).
- **PC-Friendly N64 Controls & Plug-and-Play Gamepads**:
  - Supports Xbox / PlayStation / Switch / N64 USB gamepads automatically.
  - Ergonomic keyboard defaults with a **50% Analog Walk/Tilt modifier (`Shift`)**, an optional **360° Spin Assist (`R`)** for stick-rotation minigames, and interactive keybind remapping saved to `localStorage`.
- **Cloudflare Workers Free Plan & GitHub Auto-Deploy Ready**:
  - Every static asset in `public/` is strictly `< 18 MiB` (`mp3.z64.gz.part00` = 16.00 MiB, `part01` = 8.32 MiB; gzipped WASM cores = 1.82 MiB / 1.27 MiB) and cached locally in `IndexedDB` after the first load.
  - 2 KiB EEPROM saves persist automatically in `IndexedDB`.

---

## 🎮 Default Controls

| N64 Action | Keyboard | Gamepad |
| :--- | :--- | :--- |
| **Analog Stick** | `W` `A` `S` `D` | Left Stick |
| **50% Walk / Precision Tilt** | Hold `Shift` | Half-tilt Left Stick |
| **360° Spin Assist** | Hold `R` | Rotate Left Stick |
| **A Button** | `J` or `Z` | South (`A` / `✕`) |
| **B Button** | `K` or `X` | East/West (`B`/`X` / `○`/`□`) |
| **Z Trigger** | `L` or `Space` | `LT` / `L2` |
| **C-Buttons** | `Arrow Keys` | Right Stick |
| **L / R Buttons** | `Q` / `E` | `LB` / `RB` or `RT` |
| **Start** | `Enter` | `Start` / `Menu` |
| **Rooms / Hide Top Bar** | `F2` / `F9` | — |

---

## 🚀 Local Development

No npm dependencies required:

```bash
cd marioparty3web
npm run dev
```

Open `http://localhost:8080` in 2–4 tabs (or `http://localhost:8080/?room=PARTY1`). Append `&webrtc=0` to test forced WebSocket relay fallback.

---

## ☁️ Deploying to Cloudflare Workers (Free Plan)

Configured in [`wrangler.toml`](./wrangler.toml) with Workers Static Assets (`./public`) and SQLite Durable Object (`MarioParty3RelayHub`):

```bash
npx wrangler deploy
```

### Connecting GitHub (`GladstoneOG/marioparty3web`) to Cloudflare Workers Builds
1. In the Cloudflare Dashboard: **Workers & Pages** → **Create** → **Import a repository** → select `GladstoneOG/marioparty3web`.
2. **Build command**: *(leave empty)*
3. **Deploy command**: `npx wrangler deploy`
4. Cloudflare will deploy automatically to `https://marioparty3web.johansans999.workers.dev` on every push!

---

## 🛠️ Rebuilding ROM Chunks & Cores

Place `Mario Party 3 (USA).z64` in the parent directory (or `.cache/`) and run:

```bash
npm run build:assets
```
