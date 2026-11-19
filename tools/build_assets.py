#!/usr/bin/env python3
"""
Mario Party 3 Web (marioparty3web) - ROM & Core Asset Builder
=============================================================
1. Verifies the local clean USA N64 ROM (`Mario Party 3 (USA).z64`, 32 MiB, big-endian .z64).
2. Gzip-compresses and splits it into <=16 MiB chunks under `public/roms/chunks/`
   so every static asset stays well under Cloudflare Workers' 25 MiB limit and GitHub's 100 MiB limit.
3. Gzip-compresses and stages the Libretro N64 WebAssembly core(s) into `public/cores/`.
"""

import gzip
import hashlib
import json
import os
import shutil
import zlib

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE_DIR = os.path.join(PROJECT_DIR, ".cache", "cores_extracted")
PUBLIC_DIR = os.path.join(PROJECT_DIR, "public")
ROMS_DIR = os.path.join(PUBLIC_DIR, "roms")
CHUNKS_DIR = os.path.join(ROMS_DIR, "chunks")
CORES_DIR = os.path.join(PUBLIC_DIR, "cores")

ROM_CANDIDATES = [
    os.path.join(ROOT_DIR, "Mario Party 3 (USA).z64"),
    os.path.join(PROJECT_DIR, ".cache", "Mario Party 3 (USA).z64"),
]

CHUNK_LIMIT_BYTES = 16 * 1024 * 1024  # 16 MiB max per chunk (<25 MiB Cloudflare limit)
EXPECTED_ROM_SIZE = 32 * 1024 * 1024  # 33,554,432 bytes


def crc32_hex(data: bytes) -> str:
    return f"{zlib.crc32(data) & 0xFFFFFFFF:08x}"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def find_rom() -> str:
    for path in ROM_CANDIDATES:
        if os.path.isfile(path):
            return path
    raise FileNotFoundError(
        "Could not find 'Mario Party 3 (USA).z64'. Place it in the parent workspace folder or .cache/."
    )


def normalize_to_z64(raw: bytes) -> bytes:
    """Ensure big-endian .z64 byte order (magic 80 37 12 40)."""
    magic = raw[:4]
    if magic == b"\x80\x37\x12\x40":
        return raw
    if magic == b"\x37\x80\x40\x12":
        # Byte-swapped .v64 -> .z64
        out = bytearray(len(raw))
        out[0::2] = raw[1::2]
        out[1::2] = raw[0::2]
        return bytes(out)
    if magic == b"\x40\x12\x37\x80":
        # Little-endian .n64 -> .z64
        out = bytearray(len(raw))
        out[0::4] = raw[3::4]
        out[1::4] = raw[2::4]
        out[2::4] = raw[1::4]
        out[3::4] = raw[0::4]
        return bytes(out)
    raise ValueError(f"Unrecognized N64 ROM magic bytes: {magic.hex()}")


def stage_rom():
    rom_path = find_rom()
    print(f"[ROM] Reading {rom_path} ...")
    with open(rom_path, "rb") as f:
        raw = f.read()

    if len(raw) != EXPECTED_ROM_SIZE:
        raise ValueError(f"Expected 32 MiB ROM ({EXPECTED_ROM_SIZE} bytes), got {len(raw)} bytes.")

    z64 = normalize_to_z64(raw)
    title = z64[0x20:0x34].decode("ascii", errors="replace").strip()
    game_code = z64[0x3B:0x3F].decode("ascii", errors="replace")
    rom_crc = crc32_hex(z64)
    rom_sha = sha256_hex(z64)
    print(f"  Title: {title!r}  Code: {game_code!r}  Size: {len(z64):,}  CRC32: {rom_crc}")

    if "MarioParty3" not in title.replace(" ", "") and game_code != "NMVE":
        raise ValueError(f"ROM header does not look like Mario Party 3 (USA): {title!r} / {game_code!r}")

    print("[ROM] Gzip-compressing ROM (level 6)...")
    gz_bytes = gzip.compress(z64, compresslevel=6, mtime=0)
    gz_crc = crc32_hex(gz_bytes)
    print(f"  Compressed size: {len(gz_bytes):,} bytes ({len(gz_bytes) / (1024*1024):.2f} MiB)")

    os.makedirs(CHUNKS_DIR, exist_ok=True)
    for old in os.listdir(CHUNKS_DIR):
        if old.startswith("mp3.z64.gz.part"):
            os.remove(os.path.join(CHUNKS_DIR, old))

    parts = []
    part_idx = 0
    for offset in range(0, len(gz_bytes), CHUNK_LIMIT_BYTES):
        chunk = gz_bytes[offset : offset + CHUNK_LIMIT_BYTES]
        part_name = f"mp3.z64.gz.part{part_idx:02d}"
        part_path = os.path.join(CHUNKS_DIR, part_name)
        with open(part_path, "wb") as pf:
            pf.write(chunk)
        parts.append(
            {
                "url": f"roms/chunks/{part_name}",
                "size": len(chunk),
                "crc32": crc32_hex(chunk),
            }
        )
        print(f"  + {part_name}: {len(chunk):,} bytes ({len(chunk) / (1024*1024):.2f} MiB)")
        part_idx += 1

    manifest = {
        "id": "mp3-usa",
        "title": "Mario Party 3 (USA)",
        "filename": "mp3.z64",
        "gameCode": game_code,
        "rawSize": len(z64),
        "rawCrc32": rom_crc,
        "rawSha256": rom_sha,
        "compressed": "gzip",
        "compressedSize": len(gz_bytes),
        "compressedCrc32": gz_crc,
        "chunks": parts,
    }

    manifest_path = os.path.join(ROMS_DIR, "roms.manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)
    print(f"[ROM] Wrote {manifest_path}")


def stage_core(core_name: str):
    src_dir = os.path.join(CACHE_DIR, core_name)
    js_src = os.path.join(src_dir, f"{core_name}_libretro.js")
    wasm_src = os.path.join(src_dir, f"{core_name}_libretro.wasm")
    if not (os.path.isfile(js_src) and os.path.isfile(wasm_src)):
        print(f"[CORE] Skipping {core_name} (not found in {src_dir})")
        return None

    os.makedirs(CORES_DIR, exist_ok=True)
    js_dst = os.path.join(CORES_DIR, f"{core_name}_libretro.js")
    shutil.copy2(js_src, js_dst)

    with open(wasm_src, "rb") as wf:
        wasm_raw = wf.read()
    wasm_gz = gzip.compress(wasm_raw, compresslevel=9, mtime=0)
    wasm_dst = os.path.join(CORES_DIR, f"{core_name}_libretro.wasm.bin")
    with open(wasm_dst, "wb") as out:
        out.write(wasm_gz)

    print(
        f"[CORE] Staged {core_name}: JS={os.path.getsize(js_dst):,} B, "
        f"WASM={len(wasm_raw):,} B -> {len(wasm_gz):,} B ({len(wasm_gz)/(1024*1024):.2f} MiB)"
    )
    return {
        "core": core_name,
        "js": f"cores/{core_name}_libretro.js",
        "wasmBin": f"cores/{core_name}_libretro.wasm.bin",
        "rawSize": len(wasm_raw),
        "gzSize": len(wasm_gz),
        "rawCrc32": crc32_hex(wasm_raw),
    }


def main():
    stage_rom()
    cores_meta = {}
    for core in ("mupen64plus_next", "parallel_n64"):
        info = stage_core(core)
        if info:
            cores_meta[core] = info
    with open(os.path.join(CORES_DIR, "cores.manifest.json"), "w", encoding="utf-8") as cf:
        json.dump(cores_meta, cf, indent=2)
    print("\n[DONE] Assets built successfully. Verify all files in public/ are <18 MiB.")


if __name__ == "__main__":
    main()
