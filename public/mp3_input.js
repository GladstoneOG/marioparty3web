/**
 * Mario Party 3 Web — N64 Controller Input Mapper & RetroPad Bridge
 * =================================================================
 * Packs any N64 controller state into 4 deterministic bytes:
 *   [buttonsLow, buttonsHigh, stickX (int8 -127..127), stickY (int8 -127..127)]
 *
 * Supports:
 *   - Ergonomic PC keyboard layout with Shift 50% analog walk/tilt modifier
 *     and optional R-hold 360° analog spin helper for rotation minigames
 *   - Full Gamepad API (Xbox / PlayStation / Switch / N64 USB, up to 4 pads)
 *   - Interactive keybind customization persisted in localStorage
 *   - Dirty-tracked RetroArch `simulate_input(port, index, value)` application
 */

(function () {
  "use strict";

  const BINDS_STORAGE_KEY = "mp3web-binds-v1";

  // Bit positions inside uint16 `buttons`
  const BTN = {
    A: 1 << 0,
    B: 1 << 1,
    Z: 1 << 2,
    START: 1 << 3,
    L: 1 << 4,
    R: 1 << 5,
    DUP: 1 << 6,
    DDOWN: 1 << 7,
    DLEFT: 1 << 8,
    DRIGHT: 1 << 9,
    CUP: 1 << 10,
    CDOWN: 1 << 11,
    CLEFT: 1 << 12,
    CRIGHT: 1 << 13,
  };

  // Libretro mupen64plus_next / parallel_n64 default RetroPad indices:
  //   0 = JOYPAD_B (N64 A), 1 = JOYPAD_Y (N64 B), 3 = START,
  //   4..7 = D-Pad U/D/L/R, 10 = L, 11 = R, 12 = L2 (N64 Z),
  //   16..19 = Left Stick +X/-X/+Y/-Y (N64 Analog),
  //   20..23 = Right Stick +X/-X/+Y/-Y (N64 C-Right/C-Left/C-Down/C-Up)
  const DIGITAL_MAP = [
    [BTN.A, 0],
    [BTN.B, 1],
    [BTN.START, 3],
    [BTN.DUP, 4],
    [BTN.DDOWN, 5],
    [BTN.DLEFT, 6],
    [BTN.DRIGHT, 7],
    [BTN.L, 10],
    [BTN.R, 11],
    [BTN.Z, 12],
  ];

  const DEFAULT_BINDS = {
    stickUp: "KeyW",
    stickDown: "KeyS",
    stickLeft: "KeyA",
    stickRight: "KeyD",
    tiltMod: "ShiftLeft",
    spinHelper: "KeyR",
    btnA: "KeyJ",
    btnAAlt: "KeyZ",
    btnB: "KeyK",
    btnBAlt: "KeyX",
    btnZ: "KeyL",
    btnZAlt: "Space",
    btnStart: "Enter",
    btnL: "KeyQ",
    btnR: "KeyE",
    cUp: "ArrowUp",
    cDown: "ArrowDown",
    cLeft: "ArrowLeft",
    cRight: "ArrowRight",
    dUp: "KeyT",
    dDown: "KeyG",
    dLeft: "KeyF",
    dRight: "KeyH",
  };

  const BIND_LABELS = [
    ["stickUp", "Stick Up"],
    ["stickDown", "Stick Down"],
    ["stickLeft", "Stick Left"],
    ["stickRight", "Stick Right"],
    ["btnA", "A Button"],
    ["btnB", "B Button"],
    ["btnZ", "Z Trigger"],
    ["btnStart", "Start"],
    ["btnL", "L Button"],
    ["btnR", "R Button"],
    ["cUp", "C-Up"],
    ["cDown", "C-Down"],
    ["cLeft", "C-Left"],
    ["cRight", "C-Right"],
    ["tiltMod", "50% Walk/Tilt"],
    ["spinHelper", "360° Spin Assist"],
  ];

  function loadBinds() {
    try {
      const raw = localStorage.getItem(BINDS_STORAGE_KEY);
      if (raw) return { ...DEFAULT_BINDS, ...JSON.parse(raw) };
    } catch (_) {}
    return { ...DEFAULT_BINDS };
  }

  function saveBinds(binds) {
    try {
      localStorage.setItem(BINDS_STORAGE_KEY, JSON.stringify(binds));
    } catch (_) {}
  }

  function formatKeyCode(code) {
    if (!code) return "—";
    if (code.startsWith("Key")) return code.slice(3);
    if (code.startsWith("Digit")) return code.slice(5);
    if (code === "ArrowUp") return "↑";
    if (code === "ArrowDown") return "↓";
    if (code === "ArrowLeft") return "←";
    if (code === "ArrowRight") return "→";
    if (code === "ShiftLeft" || code === "ShiftRight") return "Shift";
    if (code === "Space") return "Space";
    return code;
  }

  function packInput(buttons, stickX, stickY) {
    const bx = Math.max(-127, Math.min(127, Math.round(stickX))) & 0xff;
    const by = Math.max(-127, Math.min(127, Math.round(stickY))) & 0xff;
    return (((buttons & 0xffff) << 16) | (bx << 8) | by) >>> 0;
  }

  function unpackInput(packed) {
    const buttons = (packed >>> 16) & 0xffff;
    let sx = (packed >>> 8) & 0xff;
    let sy = packed & 0xff;
    if (sx > 127) sx -= 256;
    if (sy > 127) sy -= 256;
    return { buttons, stickX: sx, stickY: sy };
  }

  function createInputManager() {
    let binds = loadBinds();
    const keysDown = new Set();
    let spinAngle = 0;
    let spinLastMs = performance.now();
    let capturingCallback = null;

    // Dirty tracking per port (0..3)
    const appliedPacked = [0, 0, 0, 0];
    const initializedPort = [false, false, false, false];

    function isTypingInField(target) {
      if (!target) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }

    function isMappedKey(code) {
      for (const v of Object.values(binds)) {
        if (v === code) return true;
      }
      return false;
    }

    window.addEventListener(
      "keydown",
      (e) => {
        if (capturingCallback) {
          e.preventDefault();
          e.stopPropagation();
          const cb = capturingCallback;
          capturingCallback = null;
          cb(e.code === "Escape" ? null : e.code);
          return;
        }
        if (isTypingInField(e.target)) return;
        keysDown.add(e.code);
        if (isMappedKey(e.code) || e.code === "Space" || e.code.startsWith("Arrow")) {
          e.preventDefault();
        }
      },
      { passive: false }
    );

    window.addEventListener("keyup", (e) => {
      keysDown.delete(e.code);
    });

    window.addEventListener("blur", () => {
      keysDown.clear();
    });

    function sampleKeyboard() {
      let buttons = 0;
      if (keysDown.has(binds.btnA) || keysDown.has(binds.btnAAlt)) buttons |= BTN.A;
      if (keysDown.has(binds.btnB) || keysDown.has(binds.btnBAlt)) buttons |= BTN.B;
      if (keysDown.has(binds.btnZ) || keysDown.has(binds.btnZAlt)) buttons |= BTN.Z;
      if (keysDown.has(binds.btnStart)) buttons |= BTN.START;
      if (keysDown.has(binds.btnL)) buttons |= BTN.L;
      if (keysDown.has(binds.btnR)) buttons |= BTN.R;

      if (keysDown.has(binds.dUp)) buttons |= BTN.DUP;
      if (keysDown.has(binds.dDown)) buttons |= BTN.DDOWN;
      if (keysDown.has(binds.dLeft)) buttons |= BTN.DLEFT;
      if (keysDown.has(binds.dRight)) buttons |= BTN.DRIGHT;

      if (keysDown.has(binds.cUp)) buttons |= BTN.CUP;
      if (keysDown.has(binds.cDown)) buttons |= BTN.CDOWN;
      if (keysDown.has(binds.cLeft)) buttons |= BTN.CLEFT;
      if (keysDown.has(binds.cRight)) buttons |= BTN.CRIGHT;

      let sx = 0;
      let sy = 0;

      if (keysDown.has(binds.spinHelper)) {
        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.004, (now - spinLastMs) / 1000));
        spinLastMs = now;
        spinAngle = (spinAngle + dt * Math.PI * 2 * 6.5) % (Math.PI * 2);
        sx = Math.cos(spinAngle) * 127;
        sy = Math.sin(spinAngle) * 127;
      } else {
        spinLastMs = performance.now();
        if (keysDown.has(binds.stickRight)) sx += 1;
        if (keysDown.has(binds.stickLeft)) sx -= 1;
        if (keysDown.has(binds.stickDown)) sy += 1;
        if (keysDown.has(binds.stickUp)) sy -= 1;
        if (sx !== 0 || sy !== 0) {
          const mag = Math.hypot(sx, sy);
          const scale = keysDown.has(binds.tiltMod) ? 64 : 127;
          sx = (sx / mag) * scale;
          sy = (sy / mag) * scale;
        }
      }

      return { buttons, stickX: sx, stickY: sy };
    }

    function sampleGamepad(padIndex) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = pads[padIndex];
      if (!pad || !pad.connected) return null;

      const pressed = (idx) => Boolean(pad.buttons[idx] && (pad.buttons[idx].pressed || pad.buttons[idx].value > 0.35));
      let buttons = 0;
      // Standard Gamepad layout: 0=A(South), 1=B(East), 2=X(West), 3=Y(North)
      if (pressed(0)) buttons |= BTN.A;
      if (pressed(1) || pressed(2)) buttons |= BTN.B;
      if (pressed(6)) buttons |= BTN.Z; // LT -> Z
      if (pressed(9)) buttons |= BTN.START;
      if (pressed(4)) buttons |= BTN.L; // LB -> L
      if (pressed(5) || pressed(7)) buttons |= BTN.R; // RB / RT -> R
      if (pressed(12)) buttons |= BTN.DUP;
      if (pressed(13)) buttons |= BTN.DDOWN;
      if (pressed(14)) buttons |= BTN.DLEFT;
      if (pressed(15)) buttons |= BTN.DRIGHT;

      // Right stick -> C-Buttons
      const rx = pad.axes[2] || 0;
      const ry = pad.axes[3] || 0;
      if (ry < -0.45) buttons |= BTN.CUP;
      if (ry > 0.45) buttons |= BTN.CDOWN;
      if (rx < -0.45) buttons |= BTN.CLEFT;
      if (rx > 0.45) buttons |= BTN.CRIGHT;

      // Left stick -> N64 Analog with smooth radial deadzone (0.14)
      const lx = pad.axes[0] || 0;
      const ly = pad.axes[1] || 0;
      const mag = Math.hypot(lx, ly);
      let sx = 0;
      let sy = 0;
      const deadzone = 0.14;
      if (mag > deadzone) {
        const clamped = Math.min(1, (mag - deadzone) / (1 - deadzone));
        sx = (lx / mag) * clamped * 127;
        sy = (ly / mag) * clamped * 127;
      }

      return { buttons, stickX: sx, stickY: sy };
    }

    function sampleLocalPlayer(padIndex = 0, includeKeyboard = true) {
      let buttons = 0;
      let stickX = 0;
      let stickY = 0;

      if (includeKeyboard) {
        const kb = sampleKeyboard();
        buttons |= kb.buttons;
        stickX = kb.stickX;
        stickY = kb.stickY;
      }

      const gp = sampleGamepad(padIndex);
      if (gp) {
        buttons |= gp.buttons;
        if (Math.hypot(gp.stickX, gp.stickY) > Math.hypot(stickX, stickY)) {
          stickX = gp.stickX;
          stickY = gp.stickY;
        }
      }

      return packInput(buttons, stickX, stickY);
    }

    function applyPackedToPort(fnSimulateInput, port, packed) {
      if (!fnSimulateInput || port < 0 || port > 3) return;
      if (initializedPort[port] && appliedPacked[port] === packed) return;

      const prev = unpackInput(appliedPacked[port]);
      const curr = unpackInput(packed);
      const force = !initializedPort[port];

      // 1. Digital buttons
      for (let i = 0; i < DIGITAL_MAP.length; i++) {
        const [bit, retroId] = DIGITAL_MAP[i];
        const wasOn = (prev.buttons & bit) !== 0;
        const isOn = (curr.buttons & bit) !== 0;
        if (force || wasOn !== isOn) {
          fnSimulateInput(port, retroId, isOn ? 1 : 0);
        }
      }

      // 2. Left Analog Stick (indices 16:+X, 17:-X, 18:+Y, 19:-Y, range 0..32767)
      if (force || prev.stickX !== curr.stickX) {
        const posX = curr.stickX > 0 ? Math.round((curr.stickX / 127) * 32767) : 0;
        const negX = curr.stickX < 0 ? Math.round((-curr.stickX / 127) * 32767) : 0;
        fnSimulateInput(port, 16, posX);
        fnSimulateInput(port, 17, negX);
      }
      if (force || prev.stickY !== curr.stickY) {
        const posY = curr.stickY > 0 ? Math.round((curr.stickY / 127) * 32767) : 0;
        const negY = curr.stickY < 0 ? Math.round((-curr.stickY / 127) * 32767) : 0;
        fnSimulateInput(port, 18, posY);
        fnSimulateInput(port, 19, negY);
      }

      // 3. C-Buttons mapped via Right Analog axes (20:C-Right, 21:C-Left, 22:C-Down, 23:C-Up)
      const cMap = [
        [BTN.CRIGHT, 20],
        [BTN.CLEFT, 21],
        [BTN.CDOWN, 22],
        [BTN.CUP, 23],
      ];
      for (let i = 0; i < cMap.length; i++) {
        const [bit, axisId] = cMap[i];
        const wasOn = (prev.buttons & bit) !== 0;
        const isOn = (curr.buttons & bit) !== 0;
        if (force || wasOn !== isOn) {
          fnSimulateInput(port, axisId, isOn ? 32767 : 0);
        }
      }

      appliedPacked[port] = packed;
      initializedPort[port] = true;
    }

    function resetAllPorts(fnSimulateInput) {
      for (let p = 0; p < 4; p++) {
        initializedPort[p] = false;
        appliedPacked[p] = 0;
        if (fnSimulateInput) applyPackedToPort(fnSimulateInput, p, 0);
      }
    }

    function getConnectedGamepadCount() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let count = 0;
      for (const p of pads) {
        if (p && p.connected) count++;
      }
      return count;
    }

    return {
      BTN,
      BIND_LABELS,
      DEFAULT_BINDS,
      formatKeyCode,
      packInput,
      unpackInput,
      getBinds: () => ({ ...binds }),
      setBind: (action, code) => {
        binds[action] = code;
        saveBinds(binds);
      },
      resetBinds: () => {
        binds = { ...DEFAULT_BINDS };
        saveBinds(binds);
      },
      captureNextKey: (cb) => {
        capturingCallback = cb;
      },
      cancelCapture: () => {
        capturingCallback = null;
      },
      sampleLocalPlayer,
      applyPackedToPort,
      resetAllPorts,
      getConnectedGamepadCount,
    };
  }

  window.MP3Input = { createInputManager, packInput, unpackInput, formatKeyCode };
})();
